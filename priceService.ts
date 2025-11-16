// priceService.ts - PriceService robusto y "graduation-proof" para Pump.fun + fallback Jupiter
import { Connection, PublicKey, ParsedAccountData } from '@solana/web3.js';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import fetch, { Response } from 'node-fetch';
import {
  safeParseNumber,
  validateBondingCurveData,
  safeDivide,
} from './safeNumberUtils.js';
import { getRateLimiter } from './rpcRateLimiter.js';

// --- TIPOS PÚBLICOS ---

export interface PriceData {
  price: number | null;                 // precio por token en SOL
  virtualSolReserves?: number | null;   // en SOL
  virtualTokenReserves?: number | null;
  realSolReserves?: number | null;      // en SOL
  realTokenReserves?: number | null;
  graduated: boolean;
  timestamp: number;
  source: string;
  failed?: boolean;
  liquidity?: number;
  fallback?: string;
  priceImpactPct?: number;
}

export interface GraduationStatus {
  graduated: boolean;
  reason?: string;
}

export interface CalculatedValue {
  solValue: number;        // valor total en SOL
  marketPrice: number;     // precio por token en SOL
  graduated: boolean;
  source: string;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  fallback?: boolean;
}

// --- TIPOS INTERNOS ---

interface PriceCacheEntry {
  timestamp: number;
  price: number | null;
  graduated: boolean;
  source: string;
}

interface PumpPriceResult {
  price?: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  realSolReserves?: number;
  realTokenReserves?: number;
  graduated: boolean;
  timestamp?: number;
  source?: string;
  reason?: string;
}

interface JupiterQuoteResponse {
  outAmount: string;
  [key: string]: unknown;
}

interface JupiterPriceEntry {
  price?: number;
  extraInfo?: {
    liquidity?: number;
    priceImpactPct?: number;
  };
}

interface JupiterPriceResponse {
  data?: Record<string, JupiterPriceEntry>;
}

// --- INSTANCIAS COMPARTIDAS ---

const redis: RedisClient = new RedisClass(process.env.REDIS_URL as string, {
  maxRetriesPerRequest: null,
});

const connection: Connection = new Connection(
  process.env.RPC_URL as string,
  'confirmed',
);

const limiter = getRateLimiter();

const priceCache = new Map<string, PriceCacheEntry>();
const tokenDecimalsCache = new Map<string, { value: number; expiresAt: number }>();

// --- CONSTANTES ---

const SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);
const CACHE_TTL_MS = 15_000; // 15s
const TOKEN_DECIMALS_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas en memoria
const TOKEN_DECIMALS_REDIS_TTL_SECONDS = 24 * 60 * 60; // 24 horas cross-process

// --- CLASE PRINCIPAL ---

export class PriceService {
  private readonly PUMP_PROGRAM_ID: PublicKey;

  constructor() {
    if (!process.env.PUMP_PROGRAM_ID) {
      throw new Error('Missing PUMP_PROGRAM_ID for PriceService');
    }

    this.PUMP_PROGRAM_ID = new PublicKey(process.env.PUMP_PROGRAM_ID);
    console.log('💰 Price Service initialized');
    console.log('   Primary: Pump.fun bonding curve (on-chain)');
    console.log('   Fallback: Jupiter quote (token → SOL)');
    console.log('   ✅ Designed to handle graduated tokens safely');
    console.log('   🛡️ RPC rate-limited via rpcRateLimiter');

    // Limpieza periódica del cache
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of priceCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
          priceCache.delete(key);
        }
      }
    }, 10_000);

    (timer as any).unref?.();
  }

  // --- PDA bonding curve ---

  private getBondingCurvePDA(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      this.PUMP_PROGRAM_ID,
    );
    return pda;
  }

  // --- Lectura Pump.fun on-chain ---

  /**
   * Lee la bonding curve de Pump.fun y calcula el precio en SOL por token.
   * Si `complete === true`, el token está graduado y aquí devolvemos
   * `graduated: true` para que se use el fallback de DEX.
   */
  private async getPumpPrice(
    mint: string,
    _useVirtual = true,
  ): Promise<PumpPriceResult> {
    try {
      const mintPk = new PublicKey(mint);
      const bondingCurve = this.getBondingCurvePDA(mintPk);

      const accountInfo = await limiter.request(
        () => connection.getAccountInfo(bondingCurve),
        'high',
        `pump:bc:${mint}`,
      );

      if (!accountInfo) {
        return {
          graduated: false,
          reason: 'NO_BONDING_CURVE',
        };
      }

      const data = accountInfo.data;
      if (data.length < 49) {
        return {
          graduated: false,
          reason: 'INVALID_DATA_LENGTH',
        };
      }

      // Layout conocido de Pump.fun
      const virtualTokenReserves = data.readBigUInt64LE(8);   // u64
      const virtualSolReserves = data.readBigUInt64LE(16);    // u64
      const realTokenReserves = data.readBigUInt64LE(24);     // u64
      const realSolReserves = data.readBigUInt64LE(32);       // u64
      const complete = data.readUInt8(48) === 1;              // u8 bool

      if (!validateBondingCurveData(virtualSolReserves, virtualTokenReserves)) {
        return {
          graduated: complete,
          reason: 'INVALID_RESERVES',
        };
      }

      if (complete) {
        return {
          graduated: true,
          reason: 'BONDING_COMPLETE',
        };
      }

      const vSol = Number(virtualSolReserves);
      const vTok = Number(virtualTokenReserves);
      const lamportsPerToken = safeDivide(vSol, vTok, 0);
      const priceInSol = lamportsPerToken / 1e9; // SOL por token

      if (priceInSol <= 0 || !Number.isFinite(priceInSol)) {
        return {
          graduated: false,
          reason: 'BAD_PUMP_PRICE',
        };
      }

      return {
        price: priceInSol,
        virtualSolReserves: vSol / 1e9,
        virtualTokenReserves: vTok,
        realSolReserves: Number(realSolReserves) / 1e9,
        realTokenReserves: Number(realTokenReserves),
        graduated: false,
        timestamp: Date.now(),
        source: 'PUMP_FUN',
      };
    } catch (error: any) {
      console.error('   ⚠️ Pump price error:', error?.message ?? String(error));
      return {
        graduated: false,
        reason: 'EXCEPTION',
      };
    }
  }

  // --- Jupiter helpers (fallback para tokens graduados) ---

  private async getTokenDecimals(mint: PublicKey): Promise<number> {
    const mintStr = mint.toBase58();
    const now = Date.now();
    const memCached = tokenDecimalsCache.get(mintStr);
    if (memCached && memCached.expiresAt > now) {
      return memCached.value;
    }

    const redisKey = `token_decimals:${mintStr}`;
    const redisValue = await redis.get(redisKey);
    if (redisValue) {
      const parsedRedis = Number(redisValue);
      if (Number.isFinite(parsedRedis)) {
        tokenDecimalsCache.set(mintStr, {
          value: parsedRedis,
          expiresAt: now + TOKEN_DECIMALS_TTL_MS,
        });
        return parsedRedis;
      }
    }

    const info = await limiter.request(
      () => connection.getParsedAccountInfo(mint),
      'medium',
      `dec:${mintStr}`,
    );

    const parsed = info.value?.data as ParsedAccountData | undefined;
    const decimals = (parsed?.parsed as any)?.info?.decimals;
    if (typeof decimals === 'number' && Number.isFinite(decimals)) {
      tokenDecimalsCache.set(mintStr, {
        value: decimals,
        expiresAt: now + TOKEN_DECIMALS_TTL_MS,
      });
      await redis.set(
        redisKey,
        decimals.toString(),
        'EX',
        TOKEN_DECIMALS_REDIS_TTL_SECONDS,
      );
      return decimals;
    }
    return 6;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const resp: Response = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    return (await resp.json()) as T;
  }

  /**
   * Fallback: pide un quote en Jupiter para convertir tokens → SOL.
   * `tokensAmount` es cantidad en UI (no raw).
   */
  private async quoteTokenToSol(
    mint: string,
    tokensAmount: number,
  ): Promise<{ price: number; solOut: number } | null> {
    try {
      const mintPk = new PublicKey(mint);
      const decimals = await this.getTokenDecimals(mintPk);

      const uiTokens = safeParseNumber(tokensAmount, NaN, 'tokensAmount');
      if (!Number.isFinite(uiTokens) || uiTokens <= 0) {
        return null;
      }

      const rawAmount = BigInt(Math.round(uiTokens * 10 ** decimals));

      const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', SOL_MINT.toBase58());
      url.searchParams.set('amount', rawAmount.toString());
      url.searchParams.set('slippageBps', '1500');

      const quote = await this.fetchJson<JupiterQuoteResponse>(
        url.toString(),
      );

      const outLamports = BigInt(quote.outAmount);
      const solOut = Number(outLamports) / 1e9;

      if (!Number.isFinite(solOut) || solOut <= 0) {
        return null;
      }

      const pricePerToken = solOut / uiTokens;

      return {
        price: pricePerToken,
        solOut,
      };
    } catch (error: any) {
      console.error(
        '   ⚠️ Jupiter quote error:',
        error?.message ?? String(error),
      );
      return null;
    }
  }

  private async fetchJupiterPrice(
    mint: string,
  ): Promise<{ price: number; liquidity?: number; priceImpactPct?: number } | null> {
    try {
      const url = new URL('https://price.jup.ag/v6/price');
      url.searchParams.set('ids', mint);
      url.searchParams.set('vsToken', SOL_MINT.toBase58());

      const response = await this.fetchJson<JupiterPriceResponse>(url.toString());
      const entry = response?.data?.[mint];
      if (!entry) {
        return null;
      }

      const parsedPrice = safeParseNumber(entry.price, NaN, 'jupiterPrice');
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return null;
      }

      const liquidity = safeParseNumber(
        entry.extraInfo?.liquidity,
        NaN,
        'jupiterLiquidity',
      );
      const priceImpact = safeParseNumber(
        entry.extraInfo?.priceImpactPct,
        NaN,
        'jupiterImpact',
      );

      return {
        price: parsedPrice,
        liquidity: Number.isFinite(liquidity) ? liquidity : undefined,
        priceImpactPct: Number.isFinite(priceImpact) ? priceImpact : undefined,
      };
    } catch (error: any) {
      console.error(
        '   ⚠️ Jupiter price feed error:',
        error?.message ?? String(error),
      );
      return null;
    }
  }

  // --- API PÚBLICA ---

  /**
   * Devuelve el precio por token en SOL.
   * 1) Intenta Pump.fun (bonding curve)
   * 2) Si está graduado o falla, usa Jupiter como fallback
   */
  async getPrice(mint: string, useVirtual = true): Promise<PriceData> {
    const cacheKey = `${mint}:${useVirtual ? 'v' : 'r'}`;
    const now = Date.now();

    const cached = priceCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return {
        price: cached.price,
        virtualSolReserves: undefined,
        virtualTokenReserves: undefined,
        realSolReserves: undefined,
        realTokenReserves: undefined,
        graduated: cached.graduated,
        timestamp: cached.timestamp,
        source: cached.source,
      };
    }

    // 1) Pump.fun
    const pump = await this.getPumpPrice(mint, useVirtual);

    if (pump.price && !pump.graduated) {
      const entry: PriceData = {
        price: pump.price,
        virtualSolReserves: pump.virtualSolReserves ?? null,
        virtualTokenReserves: pump.virtualTokenReserves ?? null,
        realSolReserves: pump.realSolReserves ?? null,
        realTokenReserves: pump.realTokenReserves ?? null,
        graduated: false,
        timestamp: pump.timestamp ?? now,
        source: pump.source ?? 'PUMP_FUN',
      };

      priceCache.set(cacheKey, {
        timestamp: entry.timestamp,
        price: entry.price,
        graduated: entry.graduated,
        source: entry.source,
      });

      return entry;
    }

    // 2) Intentamos el price feed ligero de Jupiter
    const jupPrice = await this.fetchJupiterPrice(mint);
    if (jupPrice) {
      const entry: PriceData = {
        price: jupPrice.price,
        graduated: true,
        timestamp: now,
        source: 'JUPITER_PRICE_V6',
        virtualSolReserves: null,
        virtualTokenReserves: null,
        realSolReserves: null,
        realTokenReserves: null,
        fallback: 'JUPITER_PRICE',
        liquidity: jupPrice.liquidity,
        priceImpactPct: jupPrice.priceImpactPct,
      };

      priceCache.set(cacheKey, {
        timestamp: entry.timestamp,
        price: entry.price,
        graduated: entry.graduated,
        source: entry.source,
      });

      return entry;
    }

    // 3) Fallback Jupiter profundo: quote de 1 token
    const jup = await this.quoteTokenToSol(mint, 1);
    if (jup) {
      const entry: PriceData = {
        price: jup.price,
        graduated: true,
        timestamp: now,
        source: 'JUPITER_FALLBACK',
        virtualSolReserves: null,
        virtualTokenReserves: null,
        realSolReserves: null,
        realTokenReserves: null,
        fallback: 'JUPITER',
      };

      priceCache.set(cacheKey, {
        timestamp: entry.timestamp,
        price: entry.price,
        graduated: entry.graduated,
        source: entry.source,
      });

      return entry;
    }

    // 4) Último recurso: devolvemos nulo, marcado como fallido
    return {
      price: null,
      graduated: pump.graduated ?? false,
      timestamp: now,
      source: pump.graduated ? 'PUMP_GRADUATED_NO_DEX' : 'PRICE_FAILED',
      failed: true,
    };
  }

  /**
   * Calcula el valor actual de una posición en SOL (tokens → SOL).
   * Usa getPrice() internamente. Si no hay precio, devuelve null.
   */
  async calculateCurrentValue(
    mint: string,
    tokenAmount: number,
  ): Promise<CalculatedValue | null> {
    const priceData = await this.getPrice(mint, true);

    if (priceData.price === null || !Number.isFinite(priceData.price)) {
      const jup = await this.quoteTokenToSol(mint, tokenAmount);
      if (!jup) {
        return null;
      }

      return {
        solValue: jup.solOut,
        marketPrice: jup.price,
        graduated: true,
        source: 'JUPITER_FALLBACK',
        fallback: true,
      };
    }

    const pricePerToken = priceData.price;
    const tokens = safeParseNumber(tokenAmount, 0, 'tokenAmount');
    const solValue = tokens * pricePerToken;

    return {
      solValue,
      marketPrice: pricePerToken,
      graduated: priceData.graduated,
      source: priceData.source,
      virtualSolReserves: priceData.virtualSolReserves ?? undefined,
      virtualTokenReserves: priceData.virtualTokenReserves ?? undefined,
    };
  }

  /**
   * Check ligero de si la bonding curve marca como "complete" (graduado).
   */
  async checkGraduationStatus(mint: string): Promise<GraduationStatus> {
    const pump = await this.getPumpPrice(mint, true);
    if (pump.graduated) {
      return {
        graduated: true,
        reason: pump.reason ?? 'PUMP_COMPLETE',
      };
    }
    return { graduated: false };
  }

  /**
   * Precio directo desde DEX (Jupiter) – compatibilidad con GraduationHandler.
   */
  async getPriceFromDEX(mint: string): Promise<PriceData> {
    const now = Date.now();
    const jup = await this.quoteTokenToSol(mint, 1);
    if (jup) {
      return {
        price: jup.price,
        graduated: true,
        timestamp: now,
        source: 'JUPITER_FALLBACK',
        fallback: 'JUPITER',
      };
    }

    return {
      price: null,
      graduated: true,
      timestamp: now,
      source: 'DEX_FAILED',
      failed: true,
    };
  }
}

// --- SINGLETON ---

let singleton: PriceService | null = null;

export function getPriceService(): PriceService {
  if (!singleton) {
    singleton = new PriceService();
  }
  return singleton;
}

// Helper opcional: compatibilidad con scripts antiguos
export async function getPriceFromBondingCurve(
  mint: string,
  useVirtual = true,
): Promise<CalculatedValue | null> {
  const svc = getPriceService();
  const price = await svc.getPrice(mint, useVirtual);
  if (price.price === null) return null;

  return {
    solValue: price.price,
    marketPrice: price.price,
    graduated: price.graduated,
    source: price.source,
    virtualSolReserves: price.virtualSolReserves ?? undefined,
    virtualTokenReserves: price.virtualTokenReserves ?? undefined,
  };
}
