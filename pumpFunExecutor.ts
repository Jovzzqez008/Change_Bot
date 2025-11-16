// pumpFunExecutor.ts - FIXED: 14 accounts for buy/sell (includes creator fee accounts)
// Based on May 2025 Pump.fun update: 0.05% creator fee implementation

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Commitment,
  SendOptions,
  ConfirmOptions,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { getRateLimiter } from './rpcRateLimiter.js';
import {
  PUMP_BUY_SLIPPAGE_PCT,
  PUMP_SELL_SLIPPAGE_PCT,
} from './environment.js';
import { validateSlippage } from './safeNumberUtils.js';

// 🎯 PUMP.FUN OFFICIAL CONSTANTS (November 2024+)
export const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);
export const PUMP_GLOBAL = new PublicKey(
  '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
);
export const PUMP_FEE_RECIPIENT = new PublicKey(
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
);
export const PUMP_EVENT_AUTHORITY = new PublicKey(
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
);
export const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);

// --- Tipos de resultado ---

export interface BuyResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  solSpent?: number;
  dex?: string;
  error?: string;
  simulated?: boolean;
}

export interface SellResult {
  success: boolean;
  signature?: string;
  solReceived?: number;
  tokensSold?: number;
  dex?: string;
  error?: string;
  simulated?: boolean;
}

// Opcional: puedes ajustar compromisos por si quieres usar otro en el futuro
const DEFAULT_COMMITMENT: Commitment = 'confirmed';

const DEFAULT_PUMP_BUY_SLIPPAGE = validateSlippage(
  PUMP_BUY_SLIPPAGE_PCT,
  0.15,
);
const DEFAULT_PUMP_SELL_SLIPPAGE = validateSlippage(
  PUMP_SELL_SLIPPAGE_PCT,
  0.15,
);

export class PumpFunExecutor {
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly dryRun: boolean;
  private readonly priorityFee: number;
  private readonly rateLimiter = getRateLimiter();

  constructor(privateKey: string, rpcUrl: string, dryRun = true) {
    this.dryRun = dryRun;
    this.connection = new Connection(rpcUrl, {
      commitment: DEFAULT_COMMITMENT,
      confirmTransactionInitialTimeout: 60_000,
    });

    try {
      const cleanKey = privateKey
        .trim()
        .replace(/["']/g, '')
        .replace(/\s/g, '');

      const decoded = bs58.decode(cleanKey);

      if (decoded.length !== 64) {
        throw new Error(`Invalid key length: ${decoded.length} bytes`);
      }

      this.wallet = Keypair.fromSecretKey(decoded);
      console.log('✅ Wallet:', this.wallet.publicKey.toString());
    } catch (error: any) {
      console.error('❌ INVALID PRIVATE KEY:', error?.message ?? String(error));
      throw error;
    }

    this.priorityFee = parseInt(
      process.env.PRIORITY_FEE_MICROLAMPORTS || '300000',
      10,
    );

    console.log(`🎮 Mode: ${dryRun ? '📄 PAPER' : '💰 LIVE'}`);
    console.log(`⚡ Priority Fee: ${this.priorityFee} µlamports`);
    console.log('🛡️ RPC calls rate-limited via rpcRateLimiter\n');
  }

  // 🔧 Get Bonding Curve PDA
  getBondingCurvePDA(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM_ID,
    );
    return pda;
  }

  // 🆕 CRITICAL: Derive Creator Vault Authority PDA
  getCoinCreatorVaultAuthorityPDA(creatorPubkey: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('coin-creator-vault'), creatorPubkey.toBuffer()],
      PUMP_PROGRAM_ID,
    );
    return pda;
  }

  // 🔍 Get token creator from bonding curve or metadata
  async getTokenCreator(mint: string): Promise<PublicKey> {
    try {
      const mintPubkey = new PublicKey(mint);

      // Method 1: Try to read from bonding curve state
      const bondingCurve = this.getBondingCurvePDA(mintPubkey);
      const bondingCurveAccount = await this.rateLimiter.request(
        () => this.connection.getAccountInfo(bondingCurve),
        'high',
        `pump:creator:${mint}`,
      );

      if (
        bondingCurveAccount &&
        bondingCurveAccount.data.length >= 136 // nos aseguramos que hay espacio para el pubkey
      ) {
        // Creator is stored at offset 104 (32 bytes)
        const creatorBytes = bondingCurveAccount.data.slice(104, 136);
        const creator = new PublicKey(creatorBytes);

        // Validate it's not zero address
        if (!creator.equals(PublicKey.default)) {
          console.log(
            `   ✅ Creator found: ${creator.toString().slice(0, 8)}...`,
          );
          return creator;
        }
      }

      // Method 2: Fallback - derive from mint (for canonical pools)
      console.log(
        '   ⚠️ Creator not in bonding curve, using mint-based PDA fallback',
      );
      const [creatorPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator'), mintPubkey.toBuffer()],
        PUMP_PROGRAM_ID,
      );

      return creatorPDA;
    } catch (error: any) {
      console.error(
        `   ❌ Error getting creator: ${error?.message ?? String(error)}`,
      );

      // Ultimate fallback: use fee recipient as creator
      console.log('   ⚠️ Using fee recipient as creator fallback');
      return PUMP_FEE_RECIPIENT;
    }
  }

  // ✅ FIXED: BUY with 14 accounts (12 original + 2 creator fee)
  async buyToken(
    mint: string,
    solAmount: number,
    slippage = DEFAULT_PUMP_BUY_SLIPPAGE,
  ): Promise<BuyResult> {
    if (this.dryRun) {
      return this.simulateBuy(mint, solAmount);
    }

    try {
      console.log(`\n🔹 Buying ${mint.slice(0, 8)}... (${solAmount} SOL)`);

      const mintPubkey = new PublicKey(mint);
      const bondingCurve = this.getBondingCurvePDA(mintPubkey);

      // STEP 1: Get token creator
      console.log('   🔍 Getting token creator...');
      const creator = await this.getTokenCreator(mint);

      // STEP 2: Derive creator fee accounts
      const coinCreatorVaultAuthority =
        this.getCoinCreatorVaultAuthorityPDA(creator);
      const coinCreatorVaultAta = await getAssociatedTokenAddress(
        WSOL_MINT,
        coinCreatorVaultAuthority,
        true, // allowOwnerOffCurve
      );

      console.log(
        `   ✅ Creator vault authority: ${coinCreatorVaultAuthority
          .toString()
          .slice(0, 8)}...`,
      );
      console.log(
        `   ✅ Creator vault ATA: ${coinCreatorVaultAta
          .toString()
          .slice(0, 8)}...`,
      );

      // STEP 3: Read bonding curve state
      const bondingCurveAccount = await this.rateLimiter.request(
        () => this.connection.getAccountInfo(bondingCurve),
        'high',
        `pump:bc:buy:${mint}`,
      );

      if (!bondingCurveAccount) {
        throw new Error('Bonding curve not found');
      }

      const data = bondingCurveAccount.data;
      const virtualTokenReserves = data.readBigUInt64LE(8);
      const virtualSolReserves = data.readBigUInt64LE(16);

      // Calculate tokens out
      const solInLamports = Math.floor(solAmount * 1e9);
      const tokensOut = Math.floor(
        (Number(virtualTokenReserves) * solInLamports) /
          (Number(virtualSolReserves) + solInLamports),
      );
      const maxSolCost = Math.floor(solInLamports * (1 + slippage));

      console.log(
        `   📊 Quote: ${tokensOut.toLocaleString('en-US')} tokens`,
      );

      // STEP 4: Get ATAs
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mintPubkey,
        bondingCurve,
        true,
      );

      const associatedUser = await getAssociatedTokenAddress(
        mintPubkey,
        this.wallet.publicKey,
      );

      // STEP 5: Check if user ATA exists
      const ataInfo = await this.rateLimiter.request(
        () => this.connection.getAccountInfo(associatedUser),
        'medium',
        `ata:${associatedUser.toBase58()}`,
      );
      const needsAta = !ataInfo;

      // STEP 6: Build transaction
      const tx = new Transaction();

      // Priority fees
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.priorityFee,
        }),
      );

      // Create ATA if needed
      if (needsAta) {
        console.log('   🔧 Creating ATA...');
        tx.add(
          createAssociatedTokenAccountInstruction(
            this.wallet.publicKey,
            associatedUser,
            this.wallet.publicKey,
            mintPubkey,
          ),
        );
      }

      // ✅ 14 ACCOUNTS for BUY instruction
      const buyInstruction = new TransactionInstruction({
        keys: [
          // 0. global
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          // 1. feeRecipient
          { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
          // 2. mint
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          // 3. bondingCurve
          { pubkey: bondingCurve, isSigner: false, isWritable: true },
          // 4. associatedBondingCurve
          {
            pubkey: associatedBondingCurve,
            isSigner: false,
            isWritable: true,
          },
          // 5. associatedUser
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          // 6. user
          {
            pubkey: this.wallet.publicKey,
            isSigner: true,
            isWritable: true,
          },
          // 7. systemProgram
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          // 8. tokenProgram
          {
            pubkey: TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          // 9. rent
          {
            pubkey: SYSVAR_RENT_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
          // 10. eventAuthority
          {
            pubkey: PUMP_EVENT_AUTHORITY,
            isSigner: false,
            isWritable: false,
          },
          // 11. program
          {
            pubkey: PUMP_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          // 🆕 12. coinCreatorVaultAuthority (NEW - May 2025)
          {
            pubkey: coinCreatorVaultAuthority,
            isSigner: false,
            isWritable: false,
          },
          // 🆕 13. coinCreatorVaultAta (NEW - May 2025)
          {
            pubkey: coinCreatorVaultAta,
            isSigner: false,
            isWritable: true,
          },
        ],
        programId: PUMP_PROGRAM_ID,
        data: this.encodeBuyInstruction(tokensOut, maxSolCost),
      });

      console.log(
        `   ℹ️ Buy instruction: ${buyInstruction.keys.length} accounts (14 = FIXED)`,
      );

      tx.add(buyInstruction);

      // STEP 7: Send transaction
      console.log('   ⚡ Sending transaction...');
      const sendOpts: SendOptions = {
        skipPreflight: false,
        preflightCommitment: DEFAULT_COMMITMENT,
        maxRetries: 3,
      };
      const sig = await this.connection.sendTransaction(
        tx,
        [this.wallet],
        sendOpts,
      );

      console.log('   ⏳ Confirming...');
      const confirmOpts: ConfirmOptions = {
        commitment: DEFAULT_COMMITMENT,
        maxRetries: 3,
      };

      await this.rateLimiter.request(
        () => this.connection.confirmTransaction(sig, confirmOpts.commitment),
        'medium',
        `confirm:${sig}`,
      );

      console.log(
        `✅ BUY SUCCESS: ${solAmount} SOL → ${tokensOut} tokens`,
      );
      console.log(`   Signature: ${sig}`);

      return {
        success: true,
        signature: sig,
        tokensReceived: tokensOut,
        solSpent: solAmount,
        dex: 'Pump.fun',
      };
    } catch (error: any) {
      console.error(`❌ Buy error: ${error?.message ?? String(error)}`);

      if (error?.logs) {
        console.error('   📋 Transaction logs:');
        (error.logs as string[])
          .slice(0, 10)
          .forEach(log => console.error(`      ${log}`));
      }

      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Pump.fun',
      };
    }
  }

  // ✅ FIXED: SELL with 14 accounts (12 original + 2 creator fee)
  async sellToken(
    mint: string,
    tokenAmount: number,
    slippage = DEFAULT_PUMP_SELL_SLIPPAGE,
  ): Promise<SellResult> {
    if (this.dryRun) {
      return this.simulateSell(mint, tokenAmount);
    }

    try {
      console.log(
        `\n🔹 Selling ${mint.slice(0, 8)}... (${tokenAmount} tokens)`,
      );

      const mintPubkey = new PublicKey(mint);
      const bondingCurve = this.getBondingCurvePDA(mintPubkey);

      // STEP 1: Get token creator
      console.log('   🔍 Getting token creator...');
      const creator = await this.getTokenCreator(mint);

      // STEP 2: Derive creator fee accounts
      const coinCreatorVaultAuthority =
        this.getCoinCreatorVaultAuthorityPDA(creator);
      const coinCreatorVaultAta = await getAssociatedTokenAddress(
        WSOL_MINT,
        coinCreatorVaultAuthority,
        true,
      );

      // STEP 3: Read bonding curve state
      const bondingCurveAccount = await this.rateLimiter.request(
        () => this.connection.getAccountInfo(bondingCurve),
        'high',
        `pump:bc:sell:${mint}`,
      );

      if (!bondingCurveAccount) {
        throw new Error('Bonding curve not found');
      }

      const data = bondingCurveAccount.data;
      const virtualTokenReserves = data.readBigUInt64LE(8);
      const virtualSolReserves = data.readBigUInt64LE(16);

      // Calculate SOL out
      const solOut = Math.floor(
        (Number(virtualSolReserves) * tokenAmount) /
          (Number(virtualTokenReserves) + tokenAmount),
      );
      const minSolOutput = Math.floor(solOut * (1 - slippage));

      console.log(`   📊 Quote: ${(solOut / 1e9).toFixed(4)} SOL`);

      // STEP 4: Get ATAs
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mintPubkey,
        bondingCurve,
        true,
      );

      const associatedUser = await getAssociatedTokenAddress(
        mintPubkey,
        this.wallet.publicKey,
      );

      // STEP 5: Build transaction
      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.priorityFee,
        }),
      );

      // ✅ 14 ACCOUNTS for SELL instruction
      const sellInstruction = new TransactionInstruction({
        keys: [
          // 0. global
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          // 1. feeRecipient
          { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
          // 2. mint
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          // 3. bondingCurve
          { pubkey: bondingCurve, isSigner: false, isWritable: true },
          // 4. associatedBondingCurve
          {
            pubkey: associatedBondingCurve,
            isSigner: false,
            isWritable: true,
          },
          // 5. associatedUser
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          // 6. user
          {
            pubkey: this.wallet.publicKey,
            isSigner: true,
            isWritable: true,
          },
          // 7. systemProgram
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          // 8. associatedTokenProgram
          {
            pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          // 9. tokenProgram
          {
            pubkey: TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          // 10. eventAuthority
          {
            pubkey: PUMP_EVENT_AUTHORITY,
            isSigner: false,
            isWritable: false,
          },
          // 11. program
          {
            pubkey: PUMP_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          // 🆕 12. coinCreatorVaultAuthority (NEW - May 2025)
          {
            pubkey: coinCreatorVaultAuthority,
            isSigner: false,
            isWritable: false,
          },
          // 🆕 13. coinCreatorVaultAta (NEW - May 2025)
          {
            pubkey: coinCreatorVaultAta,
            isSigner: false,
            isWritable: true,
          },
        ],
        programId: PUMP_PROGRAM_ID,
        data: this.encodeSellInstruction(tokenAmount, minSolOutput),
      });

      console.log(
        `   ℹ️ Sell instruction: ${sellInstruction.keys.length} accounts (14 = FIXED)`,
      );

      tx.add(sellInstruction);

      // STEP 6: Send transaction
      console.log('   ⚡ Sending transaction...');
      const sendOpts: SendOptions = {
        skipPreflight: false,
        preflightCommitment: DEFAULT_COMMITMENT,
        maxRetries: 3,
      };

      const sig = await this.connection.sendTransaction(
        tx,
        [this.wallet],
        sendOpts,
      );

      console.log('   ⏳ Confirming...');
      const confirmOpts: ConfirmOptions = {
        commitment: DEFAULT_COMMITMENT,
        maxRetries: 3,
      };

      await this.rateLimiter.request(
        () => this.connection.confirmTransaction(sig, confirmOpts.commitment),
        'medium',
        `confirm:${sig}`,
      );

      const solReceived = solOut / 1e9;

      console.log(
        `✅ SELL SUCCESS: ${tokenAmount} tokens → ${solReceived.toFixed(
          4,
        )} SOL`,
      );
      console.log(`   Signature: ${sig}`);

      return {
        success: true,
        signature: sig,
        solReceived,
        tokensSold: tokenAmount,
        dex: 'Pump.fun',
      };
    } catch (error: any) {
      console.error(`❌ Sell error: ${error?.message ?? String(error)}`);

      if (error?.logs) {
        console.error('   📋 Transaction logs:');
        (error.logs as string[])
          .slice(0, 10)
          .forEach(log => console.error(`      ${log}`));
      }

      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Pump.fun',
      };
    }
  }

  // Instruction encoders
  encodeBuyInstruction(amount: number, maxSolCost: number): Buffer {
    // Pump.fun buy discriminator
    const discriminator = Buffer.from([
      0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea,
    ]);

    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amount));

    const maxSolCostBuffer = Buffer.alloc(8);
    maxSolCostBuffer.writeBigUInt64LE(BigInt(maxSolCost));

    return Buffer.concat([discriminator, amountBuffer, maxSolCostBuffer]);
  }

  encodeSellInstruction(amount: number, minSolOutput: number): Buffer {
    // Pump.fun sell discriminator
    const discriminator = Buffer.from([
      0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad,
    ]);

    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amount));

    const minSolOutputBuffer = Buffer.alloc(8);
    minSolOutputBuffer.writeBigUInt64LE(BigInt(minSolOutput));

    return Buffer.concat([discriminator, amountBuffer, minSolOutputBuffer]);
  }

  // Simulation methods
  async simulateBuy(mint: string, solAmount: number): Promise<BuyResult> {
    console.log(
      `📄 [PAPER] BUY: ${mint.slice(0, 8)}... - ${solAmount} SOL`,
    );

    const FEE_PERCENT = 0.01;
    const estimatedTokens = Math.floor(
      (solAmount / 0.00000001) * (1 - FEE_PERCENT),
    );

    return {
      success: true,
      signature: `simulated_buy_${Date.now()}`,
      tokensReceived: estimatedTokens,
      solSpent: solAmount,
      dex: 'Pump.fun',
      simulated: true,
    };
  }

  async simulateSell(
    mint: string,
    tokenAmount: number,
  ): Promise<SellResult> {
    console.log(
      `📄 [PAPER] SELL: ${mint.slice(0, 8)}... - ${tokenAmount} tokens`,
    );

    const FEE_PERCENT = 0.01;
    const estimatedSol =
      tokenAmount * 0.00000001 * (1 - FEE_PERCENT);

    return {
      success: true,
      signature: `simulated_sell_${Date.now()}`,
      solReceived: estimatedSol,
      tokensSold: tokenAmount,
      dex: 'Pump.fun',
      simulated: true,
    };
  }
}
