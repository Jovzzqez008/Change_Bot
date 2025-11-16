// graduationHandler.ts - Detecta graduación y marca posiciones, sin vender directamente.
import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

import {
  getPriceService,
  PriceService,
  GraduationStatus,
  PriceData,
  CalculatedValue,
} from './priceService.js';
import { safeParseNumber } from './safeNumberUtils.js';
import { GRADUATION_MIN_PROFIT_PERCENT } from './environment.js';

// Estructura mínima de la posición guardada en Redis
interface PositionData {
  mint?: string;
  symbol?: string;
  entryPrice?: string;
  solAmount?: string;
  tokensAmount?: string;
  entryTime?: string; // ms desde epoch, string
  status?: string;
  [key: string]: string | undefined;
}

export class GraduationHandler {
  private readonly connection: Connection;
  private readonly redis: RedisClient;
  private readonly priceService: PriceService;
  private readonly checkIntervalMs: number;
  private readonly MAX_HOLD_TIME_MS: number;
  private readonly AUTO_SELL_ON_GRADUATION: boolean;
  private readonly MIN_PROFIT_PERCENT: number;

  constructor(redisClient?: RedisClient, connectionOverride?: Connection) {
    if (!process.env.RPC_URL) {
      throw new Error('Missing RPC_URL for GraduationHandler');
    }
    if (!process.env.REDIS_URL && !redisClient) {
      throw new Error('Missing REDIS_URL for GraduationHandler');
    }

    this.connection =
      connectionOverride ??
      new Connection(process.env.RPC_URL as string, 'confirmed');

    this.redis =
      redisClient ??
      new RedisClass(process.env.REDIS_URL as string, {
        maxRetriesPerRequest: null,
      });

    this.priceService = getPriceService();
    this.checkIntervalMs = 10_000; // 10s

    this.MAX_HOLD_TIME_MS = safeParseNumber(
      parseInt(process.env.GRADUATION_MAX_HOLD_MS || '600000', 10),
      600_000,
      'GRADUATION_MAX_HOLD_MS',
    );

    this.AUTO_SELL_ON_GRADUATION =
      process.env.AUTO_SELL_ON_GRADUATION === 'true';
    this.MIN_PROFIT_PERCENT = GRADUATION_MIN_PROFIT_PERCENT;

    console.log('🎓 Graduation Handler initialized');
    console.log(
      `   Auto Sell on Graduation: ${
        this.AUTO_SELL_ON_GRADUATION ? 'ENABLED (via force_exit)' : 'DISABLED'
      }`,
    );
    if (this.MIN_PROFIT_PERCENT > 0) {
      console.log(
        `   Min Profit for Auto Sell: +${this.MIN_PROFIT_PERCENT}%`,
      );
    }
    console.log(
      '   Mode: mark graduated tokens, let copyMonitor ejecutar la venta\n',
    );
  }

  // 🔍 Verificar si un token está graduado usando PriceService
  async hasGraduated(mint: string): Promise<GraduationStatus> {
    try {
      // 1) chequeo directo de bonding curve (complete flag)
      const status: GraduationStatus =
        await this.priceService.checkGraduationStatus(mint);
      if (status.graduated) {
        return status;
      }

      // 2) si el cálculo de valor dice graduated = true
      const value: CalculatedValue | null =
        await this.priceService.calculateCurrentValue(mint, 1);
      if (value && value.graduated) {
        return { graduated: true, reason: 'dex_only_price' };
      }

      return { graduated: false };
    } catch (error: any) {
      console.log(
        `❌ Error in hasGraduated(${mint.slice(0, 8)}...):`,
        error?.message ?? String(error),
      );
      // En caso de error, mejor no forzar salida
      return { graduated: false, reason: 'error' };
    }
  }

  // Precio desde DEX (Jupiter) en SOL por token
  private async getDexPrice(mint: string): Promise<number | null> {
    try {
      const dexPrice: PriceData = await this.priceService.getPriceFromDEX(mint);
      if (
        dexPrice.price === null ||
        !Number.isFinite(dexPrice.price) ||
        dexPrice.price <= 0
      ) {
        return null;
      }
      return dexPrice.price;
    } catch (error: any) {
      console.log(
        `   ❌ Error getting DEX price for ${mint.slice(0, 8)}...:`,
        error?.message ?? String(error),
      );
      return null;
    }
  }

  // 👀 Loop opcional para monitorear posiciones abiertas y marcar graduadas
  async monitorOpenPositions(): Promise<void> {
    console.log('🎓 GraduationHandler: monitorOpenPositions loop started\n');

    // Este bucle NO vende, solo marca / setea force_exit
    while (true) {
      try {
        const openMints: string[] = await this.redis.smembers('open_positions');

        if (!openMints || openMints.length === 0) {
          await new Promise(resolve => setTimeout(resolve, this.checkIntervalMs));
          continue;
        }

        for (const mint of openMints) {
          const posKey = `position:${mint}`;
          const raw = (await this.redis.hgetall(posKey)) as PositionData;

          if (!raw || Object.keys(raw).length === 0) continue;
          if (raw.status === 'closed') continue;

          const status = await this.hasGraduated(mint);
          if (!status.graduated) continue;

          await this.handleGraduatedPosition(mint, raw, status.reason);
        }
      } catch (error: any) {
        console.log(
          '❌ Error in monitorOpenPositions loop:',
          error?.message ?? String(error),
        );
      }

      await new Promise(resolve => setTimeout(resolve, this.checkIntervalMs));
    }
  }

  // 🧠 Lógica cuando una posición se detecta como graduada
  private async handleGraduatedPosition(
    mint: string,
    position: PositionData,
    reason: string | undefined,
  ): Promise<void> {
    try {
      const now = Date.now();
      const entryTimeMs = safeParseNumber(
        parseInt(position.entryTime || '0', 10),
        0,
        'entryTime',
      );
      const holdTimeMs = entryTimeMs > 0 ? now - entryTimeMs : 0;

      console.log('\n🎓 GRADUATED POSITION DETECTED');
      console.log(`   Mint: ${mint.slice(0, 8)}...`);
      if (holdTimeMs > 0) {
        console.log(`   Hold Time: ${(holdTimeMs / 1000).toFixed(0)}s`);
      }
      if (reason) {
        console.log(`   Reason: ${reason}`);
      }

      const dexPrice = await this.getDexPrice(mint);
      if (dexPrice === null) {
        console.log('   ❌ No DEX price - marking as graduated only');
        await this.redis.hset(`position:${mint}`, 'graduated', 'true');
        await this.redis.hset(`mint:${mint}`, 'graduated', 'true');
        return;
      }

      const entryPrice = safeParseNumber(
        parseFloat(position.entryPrice || '0'),
        0,
        'entryPrice',
      );
      const tokens = safeParseNumber(
        parseFloat(position.tokensAmount || '0'),
        0,
        'tokensAmount',
      );
      const solSpent = safeParseNumber(
        parseFloat(position.solAmount || '0'),
        0,
        'solAmount',
      );

      const currentSolValue = tokens * dexPrice;
      const pnlSOL = currentSolValue - solSpent;
      const pnlPercent =
        solSpent > 0 ? (pnlSOL / solSpent) * 100 : 0;

      console.log(`   DEX Price: ${dexPrice.toFixed(10)} SOL`);
      console.log(
        `   PnL: ${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(
          4,
        )} SOL (${pnlPercent.toFixed(2)}%)`,
      );

      const meetsMinProfit =
        this.MIN_PROFIT_PERCENT <= 0 ||
        pnlPercent >= this.MIN_PROFIT_PERCENT;

      // Actualizamos info de la posición en Redis
      await this.redis.hset(`position:${mint}`, {
        graduated: 'true',
        dexPrice: dexPrice.toString(),
        dexPnl: pnlSOL.toString(),
        dexPnlPercent: pnlPercent.toString(),
      });

      await this.redis.hset(`mint:${mint}`, {
        graduated: 'true',
      });

      // 🔁 Opción: forzar salida vía copyMonitor usando force_exit
      if (this.AUTO_SELL_ON_GRADUATION && meetsMinProfit) {
        console.log(
          '   ⚠️ AUTO_SELL_ON_GRADUATION=true → setting force_exit flag',
        );
        await this.redis.setex(`force_exit:${mint}`, 120, 'graduation');
      } else if (this.AUTO_SELL_ON_GRADUATION && !meetsMinProfit) {
        console.log(
          `   ℹ️ Auto-sell skipped (needs +${this.MIN_PROFIT_PERCENT}% PnL)`,
        );
      } else {
        console.log(
          '   ℹ️ AUTO_SELL_ON_GRADUATION=false → NO se fuerza venta automática',
        );
      }
    } catch (error: any) {
      console.log(
        '   ❌ Error handling graduated position:',
        error?.message ?? String(error),
      );
    }
  }
}
