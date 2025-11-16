// multiDexExecutor.ts - Router entre Pump.fun (14 cuentas) y Jupiter, en TypeScript
// Usa PumpFunExecutor (IDL nueva con 14 cuentas) y JupiterSdkExecutor (Ultra Swap API) para Jupiter.

import {
  Connection,
  Keypair,
  PublicKey,
  Commitment,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

// Helpers numéricos
import {
  safeParseNumber,
  solToLamports,
  validateSlippage,
  safeToBigInt,
} from './safeNumberUtils.js';
import {
  JUPITER_SLIPPAGE_PCT,
  PUMP_BUY_SLIPPAGE_PCT,
  PUMP_SELL_SLIPPAGE_PCT,
} from './environment.js';

// Pump.fun executor (14 cuentas + creator fee)
import {
  PumpFunExecutor,
  PUMP_PROGRAM_ID,
  type BuyResult as PumpBuyResult,
  type SellResult as PumpSellResult,
} from './pumpFunExecutor.js';

// Jupiter executor basado en Ultra Swap API (Lite API) / SDK
import {
  JupiterSdkExecutor,
  type BuyResult as JupiterBuyResult,
  type SellResult as JupiterSellResult,
} from './jupiterSdkExecutor.js';

// --- Tipos de resultado expuestos por MultiDex ---

export interface BuyResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  solSpent?: number;
  fee?: number;
  dex?: string;
  error?: string;
  simulated?: boolean;
  fallback?: boolean;
}

export interface SellResult {
  success: boolean;
  signature?: string;
  solReceived?: number;
  tokensSold?: number;
  fee?: number;
  dex?: string;
  error?: string;
  simulated?: boolean;
  fallback?: boolean;
}

// Compromiso por defecto
const DEFAULT_COMMITMENT: Commitment = 'confirmed';
const DEFAULT_JUPITER_SLIPPAGE = validateSlippage(
  JUPITER_SLIPPAGE_PCT,
  0.15,
);
const DEFAULT_PUMP_BUY_SLIPPAGE = validateSlippage(
  PUMP_BUY_SLIPPAGE_PCT,
  0.15,
);
const DEFAULT_PUMP_SELL_SLIPPAGE = validateSlippage(
  PUMP_SELL_SLIPPAGE_PCT,
  0.15,
);

export class MultiDexExecutor {
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly dryRun: boolean;
  private readonly pumpExecutor: PumpFunExecutor;
  private readonly jupiterExecutor: JupiterSdkExecutor;
  private readonly priorityFee: number;
  private readonly PUMP_PROGRAM_ID: PublicKey;
  private readonly redis: RedisClient;

  constructor(privateKey: string, rpcUrl: string, dryRun = true) {
    this.dryRun = dryRun;

    this.connection = new Connection(rpcUrl, {
      commitment: DEFAULT_COMMITMENT,
      confirmTransactionInitialTimeout: 60_000,
    });

    // Decodificar private key
    try {
      let cleanKey = privateKey.trim();
      if (cleanKey.startsWith('"') || cleanKey.startsWith("'")) {
        cleanKey = cleanKey.slice(1);
      }
      if (cleanKey.endsWith('"') || cleanKey.endsWith("'")) {
        cleanKey = cleanKey.slice(0, -1);
      }
      cleanKey = cleanKey.replace(/\s/g, '');

      const decoded = bs58.decode(cleanKey);

      if (decoded.length !== 64) {
        throw new Error(
          `Invalid private key length: ${decoded.length} bytes (expected 64)`,
        );
      }

      this.wallet = Keypair.fromSecretKey(decoded);
      console.log('✅ Private key validated successfully');
    } catch (error: any) {
      console.error('❌ INVALID PRIVATE KEY:', error?.message ?? String(error));
      throw new Error('Invalid private key - bot cannot start');
    }

    // Pump.fun
    this.PUMP_PROGRAM_ID = PUMP_PROGRAM_ID;
    this.pumpExecutor = new PumpFunExecutor(privateKey, rpcUrl, dryRun);

    // Jupiter via Ultra Swap API v1 (Lite API)
    this.jupiterExecutor = new JupiterSdkExecutor(
      privateKey,
      rpcUrl,
      dryRun,
    );

    // Redis para leer estado de posiciones (graduated, executedDex, etc.)
    if (!process.env.REDIS_URL) {
      throw new Error('Missing REDIS_URL for MultiDexExecutor');
    }
    this.redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });

    this.priorityFee = parseInt(
      process.env.PRIORITY_FEE_MICROLAMPORTS || '50000',
      10,
    );

    console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(
      `🎮 Mode: ${
        dryRun ? 'DRY RUN (Paper Trading)' : '⚠️ LIVE TRADING'
      }`,
    );
    console.log(`⚡ Priority Fee: ${this.priorityFee} µlamports\n`);
  }

  // -------- Utilidades básicas --------

  async checkBalance(): Promise<void> {
    try {
      const balance = await this.getBalance();
      console.log(`💰 Current balance: ${balance.toFixed(4)} SOL`);

      const minBalance = 0.05;

      if (balance < minBalance) {
        console.warn(
          `⚠️  Warning: Low balance (${balance.toFixed(4)} SOL)`,
        );
        console.warn('   You may only complete 1-2 trades');
      }
    } catch (error: any) {
      console.error(
        '❌ Could not check balance:',
        error?.message ?? String(error),
      );
    }
  }

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9;
  }

  getBondingCurvePDA(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      this.PUMP_PROGRAM_ID,
    );
    return pda;
  }

  // -------- Helpers de estado: graduación --------

  private async isGraduatedOnPump(mint: string): Promise<boolean> {
    try {
      const position = (await this.redis.hgetall(
        `position:${mint}`,
      )) as Record<string, string>;

      if (!position || Object.keys(position).length === 0) {
        return false;
      }

      if (position.graduated === 'true') return true;
      if (position.executedDex === 'Jupiter') return true;

      return false;
    } catch (error: any) {
      console.warn(
        `⚠️ isGraduatedOnPump error for ${mint.slice(0, 8)}...: ${
          error?.message ?? String(error)
        }`,
      );
      // En caso de error no bloqueamos para no romper todo, pero lo logueamos
      return false;
    }
  }

  // -------- PATH Pump.fun (usa PumpFunExecutor -> 14 cuentas) --------

  private async buyOnPump(
    mint: string,
    solAmount: number,
    slippage: number,
  ): Promise<BuyResult> {
    try {
      const balance = await this.getBalance();
      const requiredBalance = solAmount + 0.005;

      if (balance < requiredBalance) {
        return {
          success: false,
          error: `Insufficient balance: ${balance.toFixed(
            4,
          )} SOL (need ${requiredBalance.toFixed(4)} SOL)`,
          dex: 'Pump.fun',
        };
      }

      console.log(
        `✅ Balance check passed: ${balance.toFixed(4)} SOL available`,
      );

      const result: PumpBuyResult = await this.pumpExecutor.buyToken(
        mint,
        solAmount,
        slippage,
      );

      return {
        ...result,
        dex: result.dex ?? 'Pump.fun',
      };
    } catch (error: any) {
      console.error(
        `❌ Pump.fun buy error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Pump.fun',
      };
    }
  }

  private async sellOnPump(
    mint: string,
    tokenAmount: number,
    slippage: number,
  ): Promise<SellResult> {
    try {
      const result: PumpSellResult = await this.pumpExecutor.sellToken(
        mint,
        tokenAmount,
        slippage,
      );

      return {
        ...result,
        dex: result.dex ?? 'Pump.fun',
      };
    } catch (error: any) {
      console.error(
        `❌ Pump.fun sell error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Pump.fun',
      };
    }
  }

  // -------- PATH Jupiter (delegado a JupiterSdkExecutor) --------

  private async buyOnJupiter(
    mint: string,
    solAmount: number,
    slippage: number,
  ): Promise<BuyResult> {
    try {
      // JupiterSdkExecutor.buyToken espera (mint, amount, slippage?)
      const res: JupiterBuyResult = await this.jupiterExecutor.buyToken(
        mint,
        solAmount,
        slippage,
      );
      return res;
    } catch (error: any) {
      console.error(
        `❌ Jupiter buy error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Jupiter',
      };
    }
  }

  private async sellOnJupiter(
    mint: string,
    tokenAmount: number,
    slippage: number,
  ): Promise<SellResult> {
    try {
      // JupiterSdkExecutor.sellToken espera (mint, amount, slippage?)
      const res: JupiterSellResult = await this.jupiterExecutor.sellToken(
        mint,
        tokenAmount,
        slippage,
      );
      return res;
    } catch (error: any) {
      console.error(
        `❌ Jupiter sell error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Jupiter',
      };
    }
  }

  // -------- Detección de mejor DEX --------

  async detectBestDex(mint: string): Promise<'Pump.fun' | 'Jupiter'> {
    try {
      const pumpExists = await this.checkPumpBondingCurve(mint);
      if (pumpExists) return 'Pump.fun';
      return 'Jupiter';
    } catch {
      return 'Jupiter';
    }
  }

  async checkPumpBondingCurve(mint: string): Promise<boolean> {
    try {
      const mintPubkey = new PublicKey(mint);
      const bondingCurve = this.getBondingCurvePDA(mintPubkey);
      const accountInfo = await this.connection.getAccountInfo(
        bondingCurve,
        DEFAULT_COMMITMENT,
      );
      return accountInfo !== null;
    } catch {
      return false;
    }
  }

  // -------- API pública: buyToken / sellToken (multi DEX) --------

  async buyToken(
    mint: string,
    solAmount: number,
    dex: 'auto' | 'Pump.fun' | 'Jupiter' | 'Raydium' | 'Orca' = 'auto',
    slippage?: number,
  ): Promise<BuyResult> {
    if (this.dryRun) {
      return this.simulateBuy(mint, solAmount, dex);
    }

    try {
      console.log(
        `\n🔹 Buying on ${dex === 'auto' ? 'best DEX' : dex}...`,
      );

      let chosenDex = dex;
      if (chosenDex === 'auto') {
        chosenDex = await this.detectBestDex(mint);
        console.log(`   ✅ Selected: ${chosenDex}`);
      }

      const fallbackSlippage =
        chosenDex === 'Pump.fun'
          ? DEFAULT_PUMP_BUY_SLIPPAGE
          : DEFAULT_JUPITER_SLIPPAGE;
      const baseSlippage =
        typeof slippage === 'number' ? slippage : fallbackSlippage;
      const checkedSlippage = validateSlippage(baseSlippage);

      switch (chosenDex) {
        case 'Pump.fun':
          return await this.buyOnPump(mint, solAmount, checkedSlippage);

        case 'Jupiter':
        case 'Raydium':
        case 'Orca':
        default:
          return await this.buyOnJupiter(mint, solAmount, checkedSlippage);
      }
    } catch (error: any) {
      console.error(
        `❌ Buy error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  async sellToken(
    mint: string,
    tokenAmount: number,
    dex: 'auto' | 'Pump.fun' | 'Jupiter' | 'Raydium' | 'Orca' = 'auto',
    slippage?: number,
  ): Promise<SellResult> {
    if (this.dryRun) {
      return this.simulateSell(mint, tokenAmount, dex);
    }

    try {
      console.log(
        `\n🔹 Selling on ${dex === 'auto' ? 'best DEX' : dex}...`,
      );

      const isGraduated = await this.isGraduatedOnPump(mint);

      let chosenDex = dex;

      // 🔒 Regla de graduación:
      // - Si el usuario pide explícitamente Pump.fun y está graduado => BLOQUEAR.
      // - Si usa 'auto' y está graduado => forzar Jupiter (no error, solo redirige).
      if (chosenDex === 'Pump.fun' && isGraduated) {
        const errorMessage =
          'Token is graduated from Pump.fun (executedDex=Jupiter). Pump.fun sell is BLOCKED. Use Jupiter.';
        console.error(`❌ ${errorMessage}`);

        return {
          success: false,
          error: errorMessage,
          dex: 'Pump.fun',
        };
      }

      if (chosenDex === 'auto') {
        if (isGraduated) {
          console.log(
            '🎓 Token graduated - forcing sell on Jupiter instead of Pump.fun',
          );
          chosenDex = 'Jupiter';
        } else {
          chosenDex = await this.detectBestDex(mint);
          console.log(`   ✅ Selected: ${chosenDex}`);
        }
      }

      const fallbackSlippage =
        chosenDex === 'Pump.fun'
          ? DEFAULT_PUMP_SELL_SLIPPAGE
          : DEFAULT_JUPITER_SLIPPAGE;
      const baseSlippage =
        typeof slippage === 'number' ? slippage : fallbackSlippage;
      const checkedSlippage = validateSlippage(baseSlippage);

      switch (chosenDex) {
        case 'Pump.fun':
          return await this.sellOnPump(mint, tokenAmount, checkedSlippage);

        case 'Jupiter':
        case 'Raydium':
        case 'Orca':
        default:
          return await this.sellOnJupiter(
            mint,
            tokenAmount,
            checkedSlippage,
          );
      }
    } catch (error: any) {
      console.error(
        `❌ Sell error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
      };
    }
  }

  // -------- Simulaciones (Paper trading) --------

  async simulateBuy(
    mint: string,
    solAmount: number,
    dex: string = 'auto',
  ): Promise<BuyResult> {
    console.log(
      `📄 [PAPER] BUY on ${dex}: ${mint.slice(0, 8)} - ${solAmount} SOL`,
    );

    try {
      const { getPriceFromBondingCurve } = (await import(
        './utils.js'
      )) as {
        getPriceFromBondingCurve: (
          mint: string,
          useVirtual?: boolean,
        ) => Promise<{
          virtualSolReserves?: number;
          virtualTokenReserves?: number;
        } | null>;
      };

      const priceData = await getPriceFromBondingCurve(mint, true);

      if (!priceData || !priceData.virtualSolReserves) {
        return this.fallbackSimulateBuy(mint, solAmount, dex);
      }

      const FEE_PERCENT = 0.01;
      const solAfterFee = solAmount * (1 - FEE_PERCENT);
      const solInLamports = solAfterFee * 1e9;

      const virtualSolReserves = priceData.virtualSolReserves * 1e9;
      const virtualTokenReserves = priceData.virtualTokenReserves ?? 0;

      const tokensOut = Math.floor(
        (virtualTokenReserves * solInLamports) /
          (virtualSolReserves + solInLamports),
      );

      console.log('\n📄 PAPER TRADE:');
      console.log(`   Spent: ${solAmount.toFixed(4)} SOL`);
      console.log(
        `   Received: ${tokensOut.toLocaleString()} tokens\n`,
      );

      return {
        success: true,
        signature: `simulated_buy_${Date.now()}`,
        tokensReceived: tokensOut,
        solSpent: solAmount,
        fee: solAmount * FEE_PERCENT,
        dex: dex || 'auto',
        simulated: true,
      };
    } catch {
      return this.fallbackSimulateBuy(mint, solAmount, dex);
    }
  }

  async simulateSell(
    mint: string,
    tokenAmount: number,
    dex: string = 'auto',
  ): Promise<SellResult> {
    console.log(
      `📄 [PAPER] SELL on ${dex}: ${mint.slice(
        0,
        8,
      )} - ${tokenAmount} tokens`,
    );

    try {
      const { getPriceFromBondingCurve } = (await import(
        './utils.js'
      )) as {
        getPriceFromBondingCurve: (
          mint: string,
          useVirtual?: boolean,
        ) => Promise<{
          virtualSolReserves?: number;
          virtualTokenReserves?: number;
        } | null>;
      };

      const priceData = await getPriceFromBondingCurve(mint, true);

      if (!priceData || !priceData.virtualSolReserves) {
        return this.fallbackSimulateSell(mint, tokenAmount, dex);
      }

      const virtualSolReserves = priceData.virtualSolReserves * 1e9;
      const virtualTokenReserves = priceData.virtualTokenReserves ?? 0;

      const solOutLamports = Math.floor(
        (virtualSolReserves * tokenAmount) /
          (virtualTokenReserves + tokenAmount),
      );

      const solBeforeFee = solOutLamports / 1e9;
      const FEE_PERCENT = 0.01;
      const solAfterFee = solBeforeFee * (1 - FEE_PERCENT);

      console.log('\n📄 PAPER TRADE:');
      console.log(
        `   Sold: ${tokenAmount.toLocaleString()} tokens`,
      );
      console.log(
        `   Received: ${solAfterFee.toFixed(4)} SOL\n`,
      );

      return {
        success: true,
        signature: `simulated_sell_${Date.now()}`,
        solReceived: solAfterFee,
        tokensSold: tokenAmount,
        fee: solBeforeFee * FEE_PERCENT,
        dex: dex || 'auto',
        simulated: true,
      };
    } catch {
      return this.fallbackSimulateSell(mint, tokenAmount, dex);
    }
  }

  private fallbackSimulateBuy(
    mint: string,
    solAmount: number,
    dex: string = 'auto',
  ): BuyResult {
    const FEE_PERCENT = 0.02;
    const estimatedTokens = Math.floor(
      (solAmount / 0.00000001) * (1 - FEE_PERCENT),
    );

    return {
      success: true,
      signature: `simulated_buy_${Date.now()}`,
      tokensReceived: estimatedTokens,
      solSpent: solAmount,
      fee: solAmount * FEE_PERCENT,
      dex: dex || 'auto',
      simulated: true,
      fallback: true,
    };
  }

  private fallbackSimulateSell(
    mint: string,
    tokenAmount: number,
    dex: string = 'auto',
  ): SellResult {
    const FEE_PERCENT = 0.02;
    const estimatedSol =
      tokenAmount * 0.00000001 * (1 - FEE_PERCENT);

    return {
      success: true,
      signature: `simulated_sell_${Date.now()}`,
      solReceived: estimatedSol,
      tokensSold: tokenAmount,
      fee: estimatedSol * FEE_PERCENT,
      dex: dex || 'auto',
      simulated: true,
      fallback: true,
    };
  }
}
