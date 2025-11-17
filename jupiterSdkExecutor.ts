// jupiterSdkExecutor.ts - Executor Jupiter Ultra Swap API v1 (Lite) con validaciones numéricas

import {
  Commitment,
  Connection,
  Keypair,
  ParsedAccountData,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import fetch, { Response } from 'node-fetch';
import https from 'https';
import {
  safeParseNumber,
  solToLamports,
  validateSlippage,
} from './safeNumberUtils.js';
import { JUPITER_SLIPPAGE_PCT } from './environment.js';

export interface BuyResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  solSpent?: number;
  dex: string; // 'Jupiter'
  error?: string;
  simulated?: boolean;
  executedDex?: string;
  tokensAmount?: number;
  effectivePrice?: number;
}

export interface SellResult {
  success: boolean;
  signature?: string;
  solReceived?: number;
  tokensSold?: number;
  dex: string; // 'Jupiter'
  error?: string;
  simulated?: boolean;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN_PRIORITY_FEE = 250_000;

const DEFAULT_JUPITER_SLIPPAGE = validateSlippage(
  JUPITER_SLIPPAGE_PCT,
  0.15,
);

interface QuoteResponse {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  outAmountWithSlippage?: string;
  contextSlot: number;
  timeTaken: number;
  priceImpactPct?: number;
  outDecimals?: number;
  inDecimals?: number;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export class JupiterSdkExecutor {
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly dryRun: boolean;
  private readonly httpsAgent: https.Agent;
  private readonly priorityFee: number;

  constructor(privateKey: string, rpcUrl: string, dryRun = true) {
    this.dryRun = dryRun;

    const commitment: Commitment = 'confirmed';
    this.connection = new Connection(rpcUrl, {
      commitment,
      confirmTransactionInitialTimeout: 60_000,
    });

    // Limpieza y validación de la private key (base58)
    const cleanKey = privateKey.trim().replace(/["'\s]/g, '');
    const secretKey = bs58.decode(cleanKey);

    if (secretKey.length !== 64) {
      throw new Error(`Invalid private key length: ${secretKey.length} bytes`);
    }
    this.wallet = Keypair.fromSecretKey(secretKey);

    this.priorityFee = Math.max(
      parseInt(
        process.env.PRIORITY_FEE_MICROLAMPORTS ?? `${MIN_PRIORITY_FEE}`,
        10,
      ) || MIN_PRIORITY_FEE,
      MIN_PRIORITY_FEE,
    );

    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 16,
      timeout: 30_000,
    });

    console.log(`💼 Jupiter SDK wallet: ${this.wallet.publicKey.toBase58()}`);
    console.log(`🎮 Mode: ${this.dryRun ? '📄 PAPER' : '💰 LIVE'}`);
    console.log(`⚡ Priority fee: ${this.priorityFee} µlamports`);
  }

  // 🔹 COMPRA usando Jupiter Ultra
  async buyToken(
    mint: string,
    solAmount: number,
    slippage: number = DEFAULT_JUPITER_SLIPPAGE,
  ): Promise<BuyResult> {
    const safeSolAmount = safeParseNumber(solAmount, NaN);
    if (Number.isNaN(safeSolAmount) || safeSolAmount <= 0) {
      return { success: false, error: 'Invalid SOL amount', dex: 'Jupiter' };
    }

    if (this.dryRun) {
      return this.simulateBuy(mint, safeSolAmount, slippage);
    }

    try {
      const lamports = solToLamports(
        safeSolAmount,
        'buy amount (JupiterSdkExecutor.buyToken)',
      );
      const quote = await this.getQuote(SOL_MINT, mint, lamports, slippage);
      if (!quote) {
        return { success: false, error: 'No route found', dex: 'Jupiter' };
      }

      const outputDecimals = await this.getTokenDecimals(new PublicKey(mint));
      const { signature } = await this.executeSwap(quote, mint, 'buy');
      const tokensReceived =
        Number(quote.outAmount) / 10 ** (quote.outDecimals ?? outputDecimals);

      console.log(
        `🪐 [Jupiter SDK] BUY: ${safeSolAmount} SOL → ${tokensReceived} tokens`,
      );

      return {
        success: true,
        signature,
        solSpent: safeSolAmount,
        tokensReceived,
        dex: 'Jupiter',
        executedDex: 'Jupiter',
        tokensAmount: tokensReceived,
        effectivePrice:
          tokensReceived > 0 ? safeSolAmount / tokensReceived : undefined,
      };
    } catch (error: any) {
      console.error(
        `❌ [Jupiter SDK] buy error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Jupiter',
      };
    }
  }

  // 🔹 VENTA usando Jupiter Ultra
  async sellToken(
    mint: string,
    tokenAmount: number,
    slippage: number = DEFAULT_JUPITER_SLIPPAGE,
  ): Promise<SellResult> {
    const safeTokenAmount = safeParseNumber(tokenAmount, NaN);
    if (Number.isNaN(safeTokenAmount) || safeTokenAmount <= 0) {
      return { success: false, error: 'Invalid token amount', dex: 'Jupiter' };
    }

    if (this.dryRun) {
      return this.simulateSell(mint, safeTokenAmount, slippage);
    }

    try {
      const decimals = await this.getTokenDecimals(new PublicKey(mint));
      const rawAmount = BigInt(Math.round(safeTokenAmount * 10 ** decimals));

      const quote = await this.getQuote(mint, SOL_MINT, rawAmount, slippage);
      if (!quote) {
        return { success: false, error: 'No route found', dex: 'Jupiter' };
      }

      const { signature } = await this.executeSwap(quote, mint, 'sell');
      const solReceived = Number(quote.outAmount) / 1e9;

      console.log(
        `🪐 [Jupiter SDK] SELL: ${safeTokenAmount} tokens → ${solReceived.toFixed(
          4,
        )} SOL`,
      );

      return {
        success: true,
        signature,
        tokensSold: safeTokenAmount,
        solReceived,
        dex: 'Jupiter',
      };
    } catch (error: any) {
      console.error(
        `❌ [Jupiter SDK] sell error: ${error?.message ?? String(error)}`,
      );
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Jupiter',
      };
    }
  }

  // 📄 Simulación de compra (paper trading)
  async simulateBuy(
    mint: string,
    solAmount: number,
    slippage: number = DEFAULT_JUPITER_SLIPPAGE,
  ): Promise<BuyResult> {
    try {
      const lamports = solToLamports(
        solAmount,
        'buy amount (simulateBuy Jupiter SDK)',
      );
      const quote = await this.getQuote(SOL_MINT, mint, lamports, slippage);
      if (!quote) {
        return {
          success: false,
          error: 'No route found',
          dex: 'Jupiter',
          simulated: true,
        };
      }

      const outputDecimals = await this.getTokenDecimals(new PublicKey(mint));
      const rawOut =
        Number(quote.outAmountWithSlippage ?? quote.outAmount) /
        10 ** (quote.outDecimals ?? outputDecimals);

      console.log(
        `📄 [PAPER][Jupiter SDK] BUY: ${solAmount} SOL → ${rawOut} tokens`,
      );

      return {
        success: true,
        tokensReceived: rawOut,
        solSpent: solAmount,
        dex: 'Jupiter',
        simulated: true,
        executedDex: 'Jupiter',
        tokensAmount: rawOut,
        effectivePrice: rawOut > 0 ? solAmount / rawOut : undefined,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Jupiter',
        simulated: true,
      };
    }
  }

  // 📄 Simulación de venta (paper trading)
  async simulateSell(
    mint: string,
    tokenAmount: number,
    slippage: number = DEFAULT_JUPITER_SLIPPAGE,
  ): Promise<SellResult> {
    try {
      const decimals = await this.getTokenDecimals(new PublicKey(mint));
      const rawAmount = BigInt(Math.round(tokenAmount * 10 ** decimals));

      const quote = await this.getQuote(mint, SOL_MINT, rawAmount, slippage);
      if (!quote) {
        return {
          success: false,
          error: 'No route found',
          dex: 'Jupiter',
          simulated: true,
        };
      }

      const solReceived =
        Number(quote.outAmountWithSlippage ?? quote.outAmount) / 1e9;

      console.log(
        `📄 [PAPER][Jupiter SDK] SELL: ${tokenAmount} tokens → ${solReceived} SOL`,
      );

      return {
        success: true,
        tokensSold: tokenAmount,
        solReceived,
        dex: 'Jupiter',
        simulated: true,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message ?? String(error),
        dex: 'Jupiter',
        simulated: true,
      };
    }
  }

  // 🔁 Ejecutar el swap (común a buy/sell) contra Ultra Swap API v1 (Lite)
  private async executeSwap(
    quote: QuoteResponse,
    _mint: string,
    side: 'buy' | 'sell',
  ) {
    const response = await this.postJson<SwapResponse>(
      'https://lite-api.jup.ag/swap/v1/swap',
      {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: this.priorityFee,
      },
    );

    if (!response?.swapTransaction) {
      throw new Error('Swap transaction missing');
    }

    const transactionBuffer = Buffer.from(response.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    transaction.sign([this.wallet]);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 3,
      },
    );

    const latestBlockhash = await this.connection.getLatestBlockhash(
      'finalized',
    );
    await this.connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: response.lastValidBlockHeight,
    });

    console.log(`🪐 [Jupiter SDK] ${side.toUpperCase()} executed: ${signature}`);

    return { signature };
  }

  // 🧮 Obtener quote de Jupiter Ultra Swap API v1
  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint | number,
    slippage: number,
  ): Promise<QuoteResponse | null> {
    const safeSlippage = validateSlippage(
      slippage,
      DEFAULT_JUPITER_SLIPPAGE,
    );
    const slippageBps = Math.floor(safeSlippage * 10_000);

    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount.toString());
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('onlyDirectRoutes', 'false');

    const quote = await this.fetchJson<QuoteResponse>(url.toString());
    if (!quote) return null;

    return quote;
  }

  // 📏 Obtener decimales de un token
  private async getTokenDecimals(mint: PublicKey): Promise<number> {
    const accountInfo = await this.connection.getParsedAccountInfo(mint);
    const data = accountInfo.value?.data as ParsedAccountData | null;

    const decimals =
      typeof (data?.parsed?.info?.decimals as number | undefined) === 'number'
        ? (data?.parsed?.info?.decimals as number)
        : 9;

    return decimals;
  }

  // -------------- Helpers HTTP (fetch / postJson) ----------------

  private async fetchJson<T>(url: string): Promise<T | null> {
    const res: Response = await fetch(url, {
      method: 'GET',
      agent: this.httpsAgent,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ Jupiter SDK fetch error: ${res.status} - ${text}`);
      return null;
    }

    const json = (await res.json()) as T;
    return json;
  }

  private async postJson<T>(url: string, body: unknown): Promise<T | null> {
    const res: Response = await fetch(url, {
      method: 'POST',
      agent: this.httpsAgent,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ Jupiter SDK post error: ${res.status} - ${text}`);
      return null;
    }

    const json = (await res.json()) as T;
    return json;
  }
}
