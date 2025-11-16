// copyStrategy.ts - ANTI-RECOMPRA + Salida dinámica (TypeScript)

import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import {
  isDryRunEnabled,
  COPY_MIN_WALLETS_TO_BUY,
  COPY_MIN_WALLETS_TO_SELL,
  COPY_PROFIT_TARGET_ENABLED,
  COPY_PROFIT_TARGET_PERCENT,
  TRAILING_STOP_ENABLED,
  TRAILING_STOP_PERCENT,
  COPY_STOP_LOSS_ENABLED,
  COPY_STOP_LOSS_PERCENT,
  COPY_MAX_HOLD_ENABLED,
  COPY_MAX_HOLD_SECONDS,
  COPY_COOLDOWN_SECONDS,
  BLOCK_REBUYS_ENABLED,
  REBUY_WINDOW_SECONDS,
} from './environment.js';

// --- Tipos auxiliares ---

interface CopySignal {
  mint: string;
  copyAmount: number;
  upvotes: number;
  buyers?: unknown;
  walletAddress: string;
}

interface Position {
  mint: string;
  symbol?: string;
  entryPrice: string;
  maxPrice?: string;
  entryTime: string; // timestamp en string
  // otros campos no usados se ignoran
}

interface TradeRecord {
  mint?: string;
  walletSource?: string;
  closedAt?: string;
  [key: string]: unknown;
}

interface CopyDecision {
  copy: boolean;
  reason?: string;
  amount?: number;
  confidence?: number;
  upvotes?: number;
  buyers?: unknown;
  mode?: 'paper' | 'live';
}

interface ExitDecision {
  exit: boolean;
  reason?: string;
  pnl?: number;
  description?: string;
  exitType?: 'automatic' | 'signal' | 'timeout';
  priority?: number;
  sellCount?: number;
  maxPnl?: number;
  holdTime?: string;
  status?: 'holding';
  [key: string]: unknown;
}

// --- Redis compartido / helper ---

function createRedisClient(): RedisClient {
  if (!process.env.REDIS_URL) {
    throw new Error('Missing REDIS_URL for CopyStrategy');
  }

  return new RedisClass(process.env.REDIS_URL as string, {
    maxRetriesPerRequest: null,
  });
}

const sharedRedis: RedisClient = createRedisClient();

// --- Clase principal ---

export class CopyStrategy {
  private readonly minWalletsToBuy: number;
  private readonly minWalletsToSell: number;

  private readonly takeProfitEnabled: boolean;
  private readonly takeProfitPercent: number;

  private readonly trailingStopEnabled: boolean;
  private readonly trailingStopPercent: number;

  private readonly stopLossEnabled: boolean;
  private readonly stopLoss: number;

  private readonly maxHoldEnabled: boolean;
  private readonly maxHoldSeconds: number;

  private readonly cooldownSeconds: number;

  // ANTI-RECOMPRA
  private readonly blockRebuys: boolean;
  private readonly rebuyWindow: number;

  constructor(private readonly redis: RedisClient = sharedRedis) {
    this.minWalletsToBuy = COPY_MIN_WALLETS_TO_BUY;
    this.minWalletsToSell = COPY_MIN_WALLETS_TO_SELL;

    this.takeProfitEnabled = COPY_PROFIT_TARGET_ENABLED;
    this.takeProfitPercent = COPY_PROFIT_TARGET_PERCENT;

    this.trailingStopEnabled = TRAILING_STOP_ENABLED;
    this.trailingStopPercent = TRAILING_STOP_PERCENT;

    this.stopLossEnabled = COPY_STOP_LOSS_ENABLED;
    this.stopLoss = COPY_STOP_LOSS_PERCENT;

    this.maxHoldEnabled = COPY_MAX_HOLD_ENABLED;
    this.maxHoldSeconds = COPY_MAX_HOLD_SECONDS;

    this.cooldownSeconds = COPY_COOLDOWN_SECONDS;

    // ✅ CONFIGURACIÓN ANTI-RECOMPRA
    this.blockRebuys = BLOCK_REBUYS_ENABLED; // Default: true
    this.rebuyWindow = REBUY_WINDOW_SECONDS; // 5 min

    console.log('🎯 Copy Strategy ANTI-RECOMPRA initialized');
    console.log(`   Min wallets to BUY: ${this.minWalletsToBuy}`);
    console.log(`   Min wallets to SELL: ${this.minWalletsToSell}`);
    console.log(
      `   🚫 Block rebuys: ${this.blockRebuys ? 'YES' : 'NO'}`,
    );
    console.log(
      `   ⏰ Rebuy window: ${this.rebuyWindow}s (${(
        this.rebuyWindow / 60
      ).toFixed(1)}min)`,
    );
    console.log('\n💰 EXIT STRATEGIES (Priority order):');
    console.log(
      `   1. Take Profit: ${
        this.takeProfitEnabled
          ? `+${this.takeProfitPercent}%`
          : 'Disabled'
      }`,
    );
    console.log(
      `   2. Trailing Stop: ${
        this.trailingStopEnabled
          ? `-${this.trailingStopPercent}% from max`
          : 'Disabled'
      }`,
    );
    console.log(
      `   3. Stop Loss: ${
        this.stopLossEnabled ? `-${this.stopLoss}%` : 'Disabled'
      }`,
    );
    console.log(`   4. Traders Sell: ${this.minWalletsToSell}+ wallets`);
    if (this.maxHoldEnabled) {
      console.log(`   5. Max Hold Time: ${this.maxHoldSeconds}s`);
    }
    console.log('');
  }

  async shouldCopy(copySignal: CopySignal): Promise<CopyDecision> {
    try {
      const { mint, copyAmount, upvotes, buyers, walletAddress } =
        copySignal;
      const dryRun = isDryRunEnabled();

      console.log(
        `\n🔍 Evaluating copy signal for ${mint.slice(0, 8)}...`,
      );
      console.log(
        `   Upvotes: ${upvotes}/${this.minWalletsToBuy}`,
      );

      // 1. Paper trading: siempre simular (pero con todas las validaciones)
      if (dryRun) {
        console.log(
          '   📝 PAPER MODE: Simulating with all validations',
        );
      }

      // 2. Live: verificar upvotes PRIMERO
      if (!dryRun && upvotes < this.minWalletsToBuy) {
        console.log(
          `   ❌ Not enough upvotes for LIVE (need ${this.minWalletsToBuy})`,
        );
        return {
          copy: false,
          reason: `low_upvotes (${upvotes}/${this.minWalletsToBuy})`,
        };
      }

      // ✅ 3. VERIFICAR SI ES RECOMPRA (CORREGIDO)
      if (this.blockRebuys) {
        const isRebuy = await this.isRebuySignal(mint, walletAddress);
        if (isRebuy) {
          console.log(
            '   🚫 REBUY BLOCKED - Already traded this token from this wallet',
          );
          console.log(
            '   ℹ️  Rule: One entry per token per wallet\n',
          );
          return { copy: false, reason: 'rebuy_blocked' };
        }
      }

      // 4. Verificar cooldown (token-level)
      const cooldown = await this.redis.get(`copy_cooldown:${mint}`);
      if (cooldown) {
        console.log('   ❌ Cooldown active (token recently traded)');
        return { copy: false, reason: 'cooldown' };
      }

      // 5. Verificar posición duplicada
      const hasPosition = await this.redis.sismember(
        'open_positions',
        mint,
      );
      if (hasPosition) {
        console.log(
          '   ❌ Already have open position in this token',
        );
        return { copy: false, reason: 'duplicate_position' };
      }

      // 6. Verificar límite de posiciones
      const openPositions = await this.redis.scard('open_positions');
      const maxPositions = parseInt(
        process.env.MAX_POSITIONS || '2',
        10,
      );

      if (openPositions >= maxPositions) {
        console.log(
          `   ❌ Max positions reached (${openPositions}/${maxPositions})`,
        );
        return { copy: false, reason: 'max_positions' };
      }

      // ✅ COPIAR APROBADO
      const mode: 'paper' | 'live' = dryRun ? 'paper' : 'live';
      const confidence = this.calculateConfidence(upvotes);

      console.log(`   ✅ Copy approved for ${mode.toUpperCase()}`);
      console.log(`   Amount: ${copyAmount.toFixed(4)} SOL`);
      console.log(`   Confidence: ${confidence}%`);

      return {
        copy: true,
        amount: copyAmount,
        confidence,
        upvotes,
        buyers,
        mode,
      };
    } catch (error: any) {
      console.error('❌ Error in shouldCopy:', error?.message ?? error);
      return { copy: false, reason: 'error' };
    }
  }

  // ✅ NUEVA LÓGICA: Detectar si YA COMPRASTE este token de este wallet antes
  async isRebuySignal(
    mint: string,
    walletAddress: string,
  ): Promise<boolean> {
    try {
      console.log('   🔍 Checking rebuy status...');

      // MÉTODO 1: ¿Ya tienes posición ABIERTA de este wallet+token?
      const hasOpenPosition = await this.redis.sismember(
        'open_positions',
        mint,
      );

      if (hasOpenPosition) {
        const position = (await this.redis.hgetall(
          `position:${mint}`,
        )) as Record<string, string>;

        if (position && position.walletSource === walletAddress) {
          console.log(
            '      ⚠️  Already have OPEN position from this wallet',
          );
          return true;
        }
      }

      // MÉTODO 2: ¿Ya compraste y cerraste este token de este wallet HOY?
      const today = new Date().toISOString().split('T')[0];
      const todayTrades = await this.redis.lrange(
        `trades:${today}`,
        0,
        -1,
      );

      for (const tradeJson of todayTrades) {
        try {
          const trade = JSON.parse(tradeJson) as TradeRecord;

          if (trade.mint === mint && trade.walletSource === walletAddress) {
            const closedAt = parseInt(trade.closedAt ?? '0', 10) || 0;
            const timeSinceClosed = Date.now() - closedAt;
            const windowMs = this.rebuyWindow * 1000;
            const minutesAgo = timeSinceClosed / 60000;

            if (timeSinceClosed < windowMs) {
              console.log(
                `      ⏰ Already traded ${minutesAgo.toFixed(
                  1,
                )}min ago (window: ${this.rebuyWindow / 60}min)`,
              );
              return true;
            } else {
              console.log(
                `      ⏰ Previous trade was ${minutesAgo.toFixed(
                  1,
                )}min ago (outside window)`,
              );
            }
          }
        } catch {
          // ignorar errores de parseo individuales
        }
      }

      // MÉTODO 3: Verificar en historial extendido (últimos 7 días)
      const keys: string[] = [];
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        keys.push(`trades:${dateKey}`);
      }

      for (const key of keys) {
        try {
          const trades = await this.redis.lrange(key, 0, -1);

          for (const tradeJson of trades) {
            try {
              const trade = JSON.parse(tradeJson) as TradeRecord;

              if (
                trade.mint === mint &&
                trade.walletSource === walletAddress
              ) {
                const closedAt = parseInt(trade.closedAt ?? '0', 10) || 0;
                const timeSinceClosed = Date.now() - closedAt;
                const windowMs = this.rebuyWindow * 1000;

                if (timeSinceClosed < windowMs) {
                  console.log(
                    '      📅 Found recent trade in history (within window)',
                  );
                  return true;
                }
              }
            } catch {
              // ignorar errores de parseo individuales
            }
          }
        } catch {
          // ignorar errores por key
        }
      }

      // ✅ NO es recompra
      console.log('      ✅ First time or rebuy window passed');
      return false;
    } catch (error: any) {
      console.log(
        `      ⚠️  Rebuy check error: ${error?.message ?? error}`,
      );
      return false;
    }
  }

  // 🚪 Decidir si salir
  async shouldExit(
    position: Position,
    currentPrice: number,
  ): Promise<ExitDecision> {
    try {
      const entryPrice = parseFloat(position.entryPrice);
      const maxPrice = parseFloat(
        position.maxPrice || position.entryPrice,
      );
      const entryTime = parseInt(position.entryTime, 10);

      const pnlPercent =
        ((currentPrice - entryPrice) / entryPrice) * 100;
      const maxPnlPercent =
        ((maxPrice - entryPrice) / entryPrice) * 100;
      const holdTime = (Date.now() - entryTime) / 1000;

      // PRIORIDAD 1: 💰 TAKE PROFIT (con lógica ligeramente dinámica)
      if (this.takeProfitEnabled && pnlPercent >= this.takeProfitPercent) {
        // 🔧 Dinámica simple:
        // - Si es muy temprano (< 60s) y el movimiento aún no es un mega-pump,
        //   preferimos NO vender aquí y dejar que el trailing stop gestione la salida.
        const isVeryEarly = holdTime < 60;
        const strongPump = maxPnlPercent >= this.takeProfitPercent * 2;

        if (!isVeryEarly || strongPump) {
          console.log(
            `\n💰 ${
              position.symbol || 'COPY'
            }: TAKE PROFIT TRIGGERED`,
          );
          console.log(
            `   Current: +${pnlPercent.toFixed(
              2,
            )}% (target: +${this.takeProfitPercent}%)`,
          );
          console.log(
            `   Max reached: +${maxPnlPercent.toFixed(2)}%`,
          );
          console.log(`   Hold time: ${holdTime.toFixed(0)}s`);

          return {
            exit: true,
            reason: 'take_profit',
            pnl: pnlPercent,
            description: `Take profit: +${pnlPercent.toFixed(
              2,
            )}% (target: +${this.takeProfitPercent}%)`,
            exitType: 'automatic',
            priority: 1,
          };
        } else {
          // muy temprano y aún no es un pump gigante:
          // dejamos correr y que se encargue el trailing stop
          console.log(
            `\n⏳ ${
              position.symbol || 'COPY'
            }: TP condition met but very early, letting trailing manage it`,
          );
        }
      }

      // PRIORIDAD 2: 📉 TRAILING STOP
      if (this.trailingStopEnabled && maxPnlPercent > 0) {
        const trailingPrice =
          maxPrice * (1 - this.trailingStopPercent / 100);
        const dropFromMax =
          ((maxPrice - currentPrice) / maxPrice) * 100;

        if (currentPrice <= trailingPrice) {
          console.log(
            `\n📉 ${
              position.symbol || 'COPY'
            }: TRAILING STOP TRIGGERED`,
          );
          console.log(
            `   Max: $${maxPrice.toFixed(
              10,
            )} (+${maxPnlPercent.toFixed(2)}%)`,
          );
          console.log(
            `   Current: $${currentPrice.toFixed(
              10,
            )} (+${pnlPercent.toFixed(2)}%)`,
          );
          console.log(
            `   Drop from max: -${dropFromMax.toFixed(
              2,
            )}% (limit: -${this.trailingStopPercent}%)`,
          );
          console.log(
            `   Protecting profit: +${pnlPercent.toFixed(2)}%`,
          );

          return {
            exit: true,
            reason: 'trailing_stop',
            pnl: pnlPercent,
            description: `Trailing stop: protecting +${pnlPercent.toFixed(
              2,
            )}% (was +${maxPnlPercent.toFixed(2)}%)`,
            exitType: 'automatic',
            priority: 2,
          };
        }
      }

      // PRIORIDAD 3: 🛑 STOP LOSS
      if (this.stopLossEnabled && pnlPercent <= -this.stopLoss) {
        console.log(
          `\n🛑 ${
            position.symbol || 'COPY'
          }: STOP LOSS TRIGGERED`,
        );
        console.log(
          `   Current: ${pnlPercent.toFixed(
            2,
          )}% (limit: -${this.stopLoss}%)`,
        );
        console.log(
          '   Protecting capital from further losses',
        );

        return {
          exit: true,
          reason: 'stop_loss',
          pnl: pnlPercent,
          description: `Stop loss: ${pnlPercent.toFixed(
            2,
          )}% (limit: -${this.stopLoss}%)`,
          exitType: 'automatic',
          priority: 3,
        };
      }

      // PRIORIDAD 4: 💼 TRADERS SOLD
      const sellCount = await this.countSellers(position.mint);

      if (sellCount >= this.minWalletsToSell) {
        console.log(
          `\n💼 ${
            position.symbol || 'COPY'
          }: TRADERS SELLING`,
        );
        console.log(
          `   Sellers: ${sellCount}/${this.minWalletsToSell} wallets`,
        );
        console.log(
          `   Current PnL: ${
            pnlPercent >= 0 ? '+' : ''
          }${pnlPercent.toFixed(2)}%`,
        );
        console.log('   Following trader exit signal');

        return {
          exit: true,
          reason: 'traders_sold',
          pnl: pnlPercent,
          sellCount,
          description: `${sellCount} trader(s) sold - following exit`,
          exitType: 'signal',
          priority: 4,
        };
      }

      // PRIORIDAD 5: ⏱️ MAX HOLD TIME
      if (this.maxHoldEnabled && holdTime >= this.maxHoldSeconds) {
        console.log(
          `\n⏱️ ${
            position.symbol || 'COPY'
          }: MAX HOLD TIME EXCEEDED`,
        );
        console.log(
          `   Hold time: ${holdTime.toFixed(
            0,
          )}s (limit: ${this.maxHoldSeconds}s)`,
        );
        console.log(
          `   Current PnL: ${
            pnlPercent >= 0 ? '+' : ''
          }${pnlPercent.toFixed(2)}%`,
        );
        console.log('   Force exit due to timeout');

        return {
          exit: true,
          reason: 'max_hold_time',
          pnl: pnlPercent,
          description: `Max hold time: ${holdTime.toFixed(
            0,
          )}s (PnL: ${pnlPercent.toFixed(2)}%)`,
          exitType: 'timeout',
          priority: 5,
        };
      }

      // ✅ CONTINUAR HOLDING
      return {
        exit: false,
        pnl: pnlPercent,
        maxPnl: maxPnlPercent,
        holdTime: holdTime.toFixed(0),
        sellCount: await this.countSellers(position.mint),
        status: 'holding',
      };
    } catch (error: any) {
      console.error('❌ Error in shouldExit:', error?.message ?? error);
      return { exit: false };
    }
  }

  async countSellers(mint: string): Promise<number> {
    try {
      const sellers = await this.redis.smembers(
        `upvotes:${mint}:sellers`,
      );
      return sellers.length;
    } catch {
      return 0;
    }
  }

  calculateConfidence(upvotes: number): number {
    if (upvotes === 1) return 30;
    if (upvotes === 2) return 70;
    if (upvotes >= 3) return 95;
    return 50;
  }

  async getBuyers(
    mint: string,
  ): Promise<
    { address: string; name?: string; amount: number; timestamp: number }[]
  > {
    try {
      const buyers = await this.redis.smembers(
        `upvotes:${mint}:buyers`,
      );
      const buyerDetails: {
        address: string;
        name?: string;
        amount: number;
        timestamp: number;
      }[] = [];

      for (const buyer of buyers) {
        const details = (await this.redis.hgetall(
          `upvotes:${mint}:buy:${buyer}`,
        )) as Record<string, string>;

        if (details && Object.keys(details).length > 0) {
          buyerDetails.push({
            address: buyer,
            name: details.walletName,
            amount: parseFloat(details.solAmount),
            timestamp: parseInt(details.timestamp, 10),
          });
        }
      }

      return buyerDetails;
    } catch {
      return [];
    }
  }
}

// Config exportable
export const COPY_STRATEGY_CONFIG = {
  minWalletsToBuy: COPY_MIN_WALLETS_TO_BUY.toString(),

  takeProfitEnabled: COPY_PROFIT_TARGET_ENABLED ? 'true' : 'false',
  takeProfitPercent: COPY_PROFIT_TARGET_PERCENT.toString(),

  trailingStopEnabled: TRAILING_STOP_ENABLED ? 'true' : 'false',
  trailingStopPercent: TRAILING_STOP_PERCENT.toString(),

  stopLossEnabled: COPY_STOP_LOSS_ENABLED ? 'true' : 'false',
  stopLossPercent: COPY_STOP_LOSS_PERCENT.toString(),

  minWalletsToSell: COPY_MIN_WALLETS_TO_SELL.toString(),

  maxHoldEnabled: COPY_MAX_HOLD_ENABLED ? 'true' : 'false',
  maxHoldSeconds: COPY_MAX_HOLD_SECONDS.toString(),

  blockRebuys: BLOCK_REBUYS_ENABLED ? 'true' : 'false',
  rebuyWindow: REBUY_WINDOW_SECONDS.toString(),

  cooldown: COPY_COOLDOWN_SECONDS.toString(),
} as const;
