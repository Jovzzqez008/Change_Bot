// riskManager.ts - PositionManager para copy trading (TypeScript)

import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import { safeParseNumber, safeDivide } from './safeNumberUtils.js';
import { isDryRunEnabled } from './environment.js';

const DRY_RUN_MODE = isDryRunEnabled();

interface DailyStats {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  totalPnL: string;
  avgPnL: string;
  biggestWin: string;
  biggestLoss: string;
}

interface TradeHistoryRecord {
  pnlSOL?: string;
  [key: string]: unknown;
}

function isRedisInstance(candidate: unknown): candidate is RedisClient {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as RedisClient).duplicate === 'function'
  );
}

export interface Position {
  mint: string;
  strategy: string;
  entryPrice: string;
  solAmount: string;
  tokensAmount: string;
  entryTime: string;

  walletSource: string;
  walletName?: string;
  upvotes?: string;
  buyers?: string;
  watchers?: string;
  sourceWallet?: string;
  originalSignature?: string;
  originalDex?: string;
  executedDex?: string;
  confidence?: string;
  exitStrategy?: string;

  // Nuevos campos para analítica estilo bot millonario
  mode?: 'DRY' | 'LIVE';
  entrySource?: string;
  dex?: string;
  strategyTag?: string;
  symbol?: string;

  status: 'open' | 'closed';

  highPrice?: string;
  lowPrice?: string;
  lastPrice?: string;
  maxPrice?: string;

  maxPnlPercent?: string;
  minPnlPercent?: string;

  closeTime?: string;
  closePrice?: string;
  pnlSOL?: string;
  pnlPercent?: string;
  closeSignature?: string;
  closeReason?: string;
}

export interface ClosedPosition {
  pnlSOL: string;
  pnlPercent: string;
}

type RegisterOpenPositionInput = {
  mint: string;
  strategy: string;
  entryPrice: number;
  solAmount: number;
  tokensAmount: number;
  buySignature?: string;
  originalSignature?: string;
  originalDex?: string;
  walletName?: string;
  walletSource?: string;
  upvotes?: number;
  executedDex?: string;
  entryTime?: number;
  [key: string]: unknown;
};

export class PositionManager {
  private readonly redis: RedisClient;
  private static readonly ESTIMATED_NETWORK_FEE_SOL = 5_000 / 1_000_000_000; // 5000 lamports ≈ 0.000005 SOL

  constructor(
    redisOrConfig?: RedisClient | Record<string, unknown>,
    redisInstance?: RedisClient,
  ) {
    if (redisInstance) {
      this.redis = redisInstance;
    } else if (isRedisInstance(redisOrConfig)) {
      this.redis = redisOrConfig;
    } else {
      if (!process.env.REDIS_URL) {
        throw new Error('REDIS_URL is not defined in environment variables');
      }
      this.redis = new RedisClass(process.env.REDIS_URL as string, {
        maxRetriesPerRequest: null,
      });
    }
  }

  async registerOpenPosition(
    input:
      | RegisterOpenPositionInput
      | {
          mint: string;
          strategy: string;
          entryPrice: number;
          solAmount: number;
          tokensAmount: number;
          buySignature?: string;
        },
  ): Promise<void> {
    const now = Date.now().toString();

    const data: RegisterOpenPositionInput = {
      ...input,
      entryPrice: input.entryPrice,
      solAmount: input.solAmount,
      tokensAmount: input.tokensAmount,
    } as RegisterOpenPositionInput;

    if (!data.mint) {
      throw new Error('registerOpenPosition: mint is required');
    }
    if (!data.strategy) {
      throw new Error('registerOpenPosition: strategy is required');
    }

    const position: Position = {
      mint: data.mint,
      strategy: data.strategy,
      entryPrice: data.entryPrice.toString(),
      solAmount: data.solAmount.toString(),
      tokensAmount: data.tokensAmount.toString(),
      entryTime: (data.entryTime ?? Number(now)).toString(),
      walletSource: data.walletSource ? String(data.walletSource) : '',
      walletName: data.walletName ? String(data.walletName) : undefined,
      upvotes:
        data.upvotes !== undefined ? String(Math.trunc(data.upvotes)) : undefined,
      executedDex: data.executedDex ? String(data.executedDex) : undefined,
      status: 'open',
      // defaults para analíticas
      mode: DRY_RUN_MODE ? 'DRY' : 'LIVE',
      entrySource: data.strategy || 'UNKNOWN',
      dex: undefined,
      strategyTag: data.strategy,
      symbol: data.mint,
    };

    const signature =
      data.buySignature ?? (typeof data.originalSignature === 'string'
        ? data.originalSignature
        : undefined);
    if (signature) {
      position.originalSignature = signature;
    }
    if (typeof data.originalDex === 'string') {
      position.originalDex = data.originalDex;
    }

    await this.redis.sadd('open_positions', data.mint);
    await this.redis.hset(
      `position:${data.mint}`,
      Object.entries(position).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== undefined && v !== null) {
          acc[k] = String(v);
        }
        return acc;
      }, {}),
    );
  }

  // Mantener API usada por copyMonitor.ts
  async openPosition(
    mint: string,
    strategy: string,
    entryPrice: number,
    solAmount: number,
    tokensAmount: number,
    buySignature?: string,
  ): Promise<void> {
    await this.registerOpenPosition({
      mint,
      strategy,
      entryPrice,
      solAmount,
      tokensAmount,
      buySignature,
    });
  }

  async getPosition(mint: string): Promise<Position | null> {
    const exists = await this.redis.sismember('open_positions', mint);
    if (!exists) {
      return null;
    }
    const data = await this.redis.hgetall(`position:${mint}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return { ...(data as unknown as Position), mint };
  }

  async getOpenPositions(): Promise<Position[]> {
    const mints = await this.redis.smembers('open_positions');
    if (!mints || mints.length === 0) {
      return [];
    }

    const positions: Position[] = [];
    for (const mint of mints) {
      const data = await this.redis.hgetall(`position:${mint}`);
      if (!data || Object.keys(data).length === 0) {
        continue;
      }

      positions.push({
        ...(data as unknown as Position),
        mint,
      });
    }

    return positions;
  }

  async updateMaxPrice(mint: string, price: number): Promise<void> {
    await this.redis.hset(`position:${mint}`, {
      maxPrice: price.toString(),
    });
  }

  async updatePositionOnPrice(
    mint: string,
    lastPrice: number,
    pnlPercent: number,
  ): Promise<void> {
    const key = `position:${mint}`;
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) {
      return;
    }

    const updated: Partial<Position> = {
      lastPrice: lastPrice.toString(),
    };

    const currentMax = raw.maxPnlPercent ? parseFloat(raw.maxPnlPercent) : null;
    const currentMin = raw.minPnlPercent ? parseFloat(raw.minPnlPercent) : null;

    if (currentMax === null || pnlPercent > currentMax) {
      updated.maxPnlPercent = pnlPercent.toString();
    }
    if (currentMin === null || pnlPercent < currentMin) {
      updated.minPnlPercent = pnlPercent.toString();
    }

    await this.redis.hset(
      key,
      Object.entries(updated).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== undefined && v !== null) {
          acc[k] = String(v);
        }
        return acc;
      }, {}),
    );
  }

  async closePosition(
    mint: string,
    closePrice: number,
    tokensSold: number,
    solReceived?: number,
    reason?: string,
    closeSignature?: string,
  ): Promise<ClosedPosition> {
    const key = `position:${mint}`;
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) {
      throw new Error(`Position not found for mint ${mint}`);
    }

    const closeTime = Date.now().toString();
    const solSpent = safeParseNumber(raw.solAmount, 0, 'position.solAmount');
    const tokensHeld = safeParseNumber(
      raw.tokensAmount,
      0,
      'position.tokensAmount',
    );

    const fallbackTokensSold =
      tokensHeld > 0 ? tokensHeld : safeParseNumber(tokensSold, 0, 'tokensSold');

    const normalizedTokensSold = (() => {
      const requested = safeParseNumber(tokensSold, tokensHeld || 0, 'tokensSold');
      if (tokensHeld <= 0) {
        return requested;
      }
      if (!Number.isFinite(requested) || requested <= 0) {
        return tokensHeld;
      }
      return Math.min(requested, tokensHeld);
    })();

    const resolvedClosePrice = Number.isFinite(closePrice)
      ? closePrice
      : safeParseNumber(raw.lastPrice ?? raw.entryPrice, 0, 'closePrice');

    const costBasis = (() => {
      if (tokensHeld <= 0 || solSpent <= 0) {
        return solSpent;
      }
      const avgEntryPrice = safeDivide(solSpent, tokensHeld, 0);
      return avgEntryPrice * normalizedTokensSold;
    })();

    const avgEntryPrice =
      tokensHeld > 0 ? safeDivide(solSpent, tokensHeld, 0) : 0;

    const fallbackSolValue =
      resolvedClosePrice * (normalizedTokensSold || fallbackTokensSold);

    const safeSolReceived =
      typeof solReceived === 'number' && Number.isFinite(solReceived)
        ? solReceived
        : fallbackSolValue;

    const estimatedFees = DRY_RUN_MODE
      ? 0
      : PositionManager.ESTIMATED_NETWORK_FEE_SOL;

    const realizedSol = Math.max(safeSolReceived - estimatedFees, 0);
    const pnlSOL = realizedSol - costBasis;
    const pnlPercent = costBasis === 0 ? 0 : (pnlSOL / costBasis) * 100;

    const updated: Partial<Position> = {
      status: 'closed',
      closePrice: resolvedClosePrice.toString(),
      pnlSOL: pnlSOL.toString(),
      pnlPercent: pnlPercent.toString(),
      closeTime,
      closeReason: reason,
      tokensAmount: tokensHeld.toString(),
      solAmount: solSpent.toString(),
      lastPrice: resolvedClosePrice.toString(),
      maxPrice: raw.maxPrice ?? raw.highPrice ?? undefined,
      minPnlPercent: raw.minPnlPercent,
      maxPnlPercent: raw.maxPnlPercent,
    };

    if (Number.isFinite(avgEntryPrice) && avgEntryPrice > 0) {
      updated.entryPrice = avgEntryPrice.toString();
    }

    if (closeSignature) {
      updated.closeSignature = closeSignature;
    }

    await this.redis.srem('open_positions', mint);
    await this.redis.hset(
      key,
      Object.entries(updated).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== undefined && v !== null) {
          acc[k] = String(v);
        }
        return acc;
      }, {}),
    );

    // Registro en historial diario, alineado con analytics.ts
    const dayKey = `trades:${new Date().toISOString().slice(0, 10)}`;

    const avgEntryPriceStr =
      Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
        ? avgEntryPrice.toString()
        : raw.entryPrice ?? '0';

    const tradeRecord = {
      ...raw,
      ...updated,
      mint,
      closedAt: closeTime,
      walletSource: raw.walletSource ?? '',
      solReceived: realizedSol.toString(),
      tokensSold: normalizedTokensSold.toString(),
      costBasis: costBasis.toString(),
      estimatedFees: estimatedFees.toString(),
      avgEntryPrice: avgEntryPrice.toString(),
      simulated: DRY_RUN_MODE ? 'true' : 'false',

      // Campos para analytics.Trade
      symbol: (raw as any).symbol ?? mint,
      entryTime: raw.entryTime ?? closeTime,
      exitTime: closeTime,
      entryPrice: avgEntryPriceStr,
      exitPrice: resolvedClosePrice.toString(),
      solAmount: raw.solAmount ?? solSpent.toString(),
      pnlSOL: pnlSOL.toString(),
      pnlPercent: pnlPercent.toString(),
      reason: reason ?? raw.closeReason ?? '',

      // Metadata para modo / fuente / dex / estrategia
      mode: (raw as any).mode ?? (DRY_RUN_MODE ? 'DRY' : 'LIVE'),
      entrySource:
        (raw as any).entrySource ??
        raw.strategy ??
        '',
      dex:
        (raw as any).dex ??
        raw.executedDex ??
        raw.originalDex ??
        '',
      strategyTag:
        (raw as any).strategyTag ??
        raw.exitStrategy ??
        raw.strategy ??
        '',
    };

    await this.redis.rpush(dayKey, JSON.stringify(tradeRecord));

    return {
      pnlSOL: pnlSOL.toString(),
      pnlPercent: pnlPercent.toString(),
    };
  }

  async getDailyStats(): Promise<DailyStats | null> {
    const dateKey = new Date().toISOString().slice(0, 10);
    const possibleKeys = [`trades:${dateKey}`, `trades:trades:${dateKey}`];

    let entries: string[] = [];
    for (const key of possibleKeys) {
      const data = await this.redis.lrange(key, 0, -1);
      if (data.length > 0) {
        entries = data;
        break;
      }
    }

    if (entries.length === 0) {
      return null;
    }

    let wins = 0;
    let losses = 0;
    let totalTrades = 0;
    let totalPnL = 0;
    let biggestWin = -Infinity;
    let biggestLoss = Infinity;

    for (const entry of entries) {
      try {
        const record = JSON.parse(entry) as TradeHistoryRecord;
        const pnl = parseFloat(record.pnlSOL ?? '0');
        totalTrades++;
        if (pnl >= 0) {
          wins++;
          if (pnl > biggestWin) biggestWin = pnl;
        } else {
          losses++;
          if (pnl < biggestLoss) biggestLoss = pnl;
        }
        totalPnL += pnl;
      } catch {
        // ignore malformed entries
      }
    }

    if (totalTrades === 0) {
      return null;
    }

    const normalizedBiggestWin =
      biggestWin === -Infinity ? 0 : biggestWin;
    const normalizedBiggestLoss =
      biggestLoss === Infinity ? 0 : biggestLoss;

    const winRate = (wins / totalTrades) * 100;

    return {
      date: dateKey,
      totalTrades,
      wins,
      losses,
      winRate: `${winRate.toFixed(1)}%`,
      totalPnL: totalPnL.toFixed(4),
      avgPnL: (totalPnL / totalTrades).toFixed(4),
      biggestWin: normalizedBiggestWin.toFixed(4),
      biggestLoss: normalizedBiggestLoss.toFixed(4),
    };
  }
}

// Alias export
export { PositionManager as RiskManager };
