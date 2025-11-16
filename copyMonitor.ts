// copyMonitor.ts - HYBRID smart copy trading monitor (TypeScript, aligned with MultiDexExecutor)

import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import { CopyStrategy } from './copyStrategy.js';
import { sendTelegramAlert } from './telegram.js';
import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { getPriceService, type PriceService } from './priceService.js';
import {
  isDryRunEnabled,
  ENABLE_AUTO_TRADING,
  TELEGRAM_LIVE_UPDATES_ENABLED,
  TELEGRAM_OWNER_CHAT_ID,
  POSITION_SIZE_SOL,
  COPY_MIN_WALLETS_TO_SELL,
  COPY_PROFIT_TARGET_PERCENT,
  TRAILING_STOP_PERCENT,
  COPY_STOP_LOSS_PERCENT,
} from './environment.js';

// En vez de usar PumpFunExecutor directo, usamos MultiDexExecutor que ya maneja:
// - Pump.fun 14 cuentas
// - Jupiter optimizado
// - BLOQUEO de venta en Pump.fun si el token está graduado
import {
  MultiDexExecutor,
  type BuyResult,
  type SellResult,
} from './multiDexExecutor.js';

import type {
  PositionManager,
  Position,
  ClosedPosition,
} from './riskManager.js';

// --- Tipos auxiliares ---

interface CopySignal {
  walletName: string;
  walletAddress: string;
  mint: string;
  upvotes: number;
  signature: string;
  dex?: string;
}

interface CopyDecision {
  copy: boolean;
  reason: string;
  mode: string;
  amount: number;
  upvotes: number;
  buyers: unknown[];
  confidence: number;
}

interface ExitDecision {
  exit: boolean;
  reason: string;
  description: string;
  priority?: number;
}

interface HybridExitDecision {
  shouldExit: boolean;
  phase: string;
  reason?: string;
  description?: string;
  priority?: number;
}

interface WalletSellCheck {
  sold: boolean;
  timestamp?: number;
  cached?: boolean;
  signature?: string;
}

interface ValueData {
  marketPrice: number;
  solValue: number;
}

interface SellSignal {
  mint: string;
  sellCount: number;
  sellers: string[];
}

// tradeExecutor ahora es MultiDexExecutor (Pump.fun + Jupiter),
// con firma: buyToken(mint, sol, dex?, slippage?), sellToken(mint, tokens, dex?, slippage?)
type TradeExecutor = {
  buyToken: (
    mint: string,
    solAmount: number,
    dex?: 'auto' | 'Pump.fun' | 'Jupiter' | 'Raydium' | 'Orca',
    slippage?: number,
  ) => Promise<BuyResult>;
  sellToken: (
    mint: string,
    tokenAmount: number,
    dex?: 'auto' | 'Pump.fun' | 'Jupiter' | 'Raydium' | 'Orca',
    slippage?: number,
  ) => Promise<SellResult>;
};

// --- Instancias base ---

const redis: RedisClient = new RedisClass(process.env.REDIS_URL as string, {
  maxRetriesPerRequest: null,
});

const connection = new Connection(process.env.RPC_URL as string, 'confirmed');
const copyStrategy = new CopyStrategy();
const priceService: PriceService = getPriceService();

const ENABLE_TRADING = ENABLE_AUTO_TRADING;
const DRY_RUN = isDryRunEnabled();
const LIVE_UPDATES = TELEGRAM_LIVE_UPDATES_ENABLED;

// 🎯 HYBRID STRATEGY CONFIG
const WALLET_EXIT_WINDOW = 180000; // 3 minutes
const LOSS_PROTECTION_WINDOW = 600000; // 10 minutes
const INDEPENDENT_MODE_TIME = 600000; // After 10 min

let tradeExecutor: TradeExecutor | null = null;
let positionManager: PositionManager | null = null;

// --- Inicialización de trading (dinámica) ---
//
// AHORA: siempre intentamos crear un MultiDexExecutor, que internamente:
// - Usa PumpFunExecutor (14 accounts + creator fee) para Pump.fun
// - Usa OptimizedJupiterExecutor para Jupiter
// - Bloquea venta en Pump.fun cuando el token está graduado
//
if (ENABLE_TRADING) {
  (async () => {
    try {
      const { PositionManager: PositionManagerClass } = await import(
        './riskManager.js'
      );
      const { MultiDexExecutor: MultiDexExecutorClass } = await import(
        './multiDexExecutor.js'
      );

      tradeExecutor = new MultiDexExecutorClass(
        process.env.PRIVATE_KEY as string,
        process.env.RPC_URL as string,
        DRY_RUN,
      ) as unknown as TradeExecutor;

      positionManager = new PositionManagerClass(redis);

      console.log(
        `💼 Smart Copy Trading ${DRY_RUN ? '📄 PAPER' : '💰 LIVE'} enabled`,
      );
      console.log(`   Position Size (legacy): ${POSITION_SIZE_SOL} SOL`);
      console.log('   🎯 HYBRID exit strategy active');
      console.log(
        '   ✅ Pump.fun 14 accounts + Jupiter + graduation-safe sells\n',
      );
    } catch (error: any) {
      console.error('⚠️ Trading init failed:', error?.message ?? String(error));
      console.error('   Stack:', error?.stack ?? 'no stack');
      tradeExecutor = null;
      positionManager = null;
    }
  })().catch((err) => {
    console.error('⚠️ Trading init async error:', err);
  });
}

// --- Utilidades ---

async function calculateCurrentValue(
  mint: string,
  tokenAmount: number,
): Promise<ValueData | null> {
  try {
    const data = await priceService.calculateCurrentValue(mint, tokenAmount);
    if (!data) return null;
    return {
      marketPrice: data.marketPrice,
      solValue: data.solValue,
    };
  } catch (error: any) {
    console.error('   ❌ Error calculating value:', error?.message ?? String(error));
    return null;
  }
}

async function checkTrackedWalletSold(
  mint: string,
  walletAddress: string,
): Promise<WalletSellCheck> {
  try {
    const recentSell = await redis.get(
      `wallet_sold:${walletAddress}:${mint}`,
    );
    if (recentSell) {
      return {
        sold: true,
        timestamp: parseInt(recentSell, 10),
        cached: true,
      };
    }

    const signatures = await connection.getSignaturesForAddress(
      new PublicKey(walletAddress),
      { limit: 20 },
    );

    for (const sig of signatures) {
      const fiveMinutesAgo = Date.now() - 300000;
      if ((sig.blockTime ?? 0) * 1000 < fiveMinutesAgo) break;

      try {
        const tx: ParsedTransactionWithMeta | null =
          await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

        if (!tx || !tx.meta || tx.meta.err) continue;

        const postTokenBalances = tx.meta.postTokenBalances || [];
        const preTokenBalances = tx.meta.preTokenBalances || [];

        for (let i = 0; i < postTokenBalances.length; i++) {
          const post = postTokenBalances[i];
          const pre = preTokenBalances.find(
            (p) => p.accountIndex === post.accountIndex,
          );

          if (
            post.mint === mint &&
            pre &&
            post.uiTokenAmount.uiAmount <
              (pre.uiTokenAmount.uiAmount ?? 0)
          ) {
            const sellTime = (sig.blockTime ?? 0) * 1000;
            await redis.setex(
              `wallet_sold:${walletAddress}:${mint}`,
              600,
              sellTime.toString(),
            );

            return {
              sold: true,
              timestamp: sellTime,
              signature: sig.signature,
            };
          }
        }
      } catch {
        continue;
      }
    }

    return { sold: false };
  } catch (error: any) {
    console.error(
      '   ⚠️ Error checking wallet sell:',
      error?.message ?? String(error),
    );
    return { sold: false };
  }
}

async function evaluateHybridExit(
  position: Position,
  currentPrice: number,
  pnlPercent: number,
  currentSolValue: number,
): Promise<HybridExitDecision> {
  const holdTime = Date.now() - parseInt(position.entryTime, 10);
  const walletAddress = position.walletSource;
  const mint = position.mint;

  if (!walletAddress) {
    return { shouldExit: false, phase: 'none' };
  }

  const walletSellCheck = await checkTrackedWalletSold(mint, walletAddress);

  if (!walletSellCheck.sold) {
    return { shouldExit: false, phase: 'none' };
  }

  const sellTime = walletSellCheck.timestamp!;
  const timeSinceSell = Date.now() - sellTime;

  if (sellTime < parseInt(position.entryTime, 10)) {
    return { shouldExit: false, phase: 'none' };
  }

  if (holdTime < WALLET_EXIT_WINDOW) {
    console.log(`\n⚡ PHASE 1: WALLET EXIT DETECTED (0-3 min)`);
    console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
    console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
    console.log(
      `   Current PnL: ${
        pnlPercent >= 0 ? '+' : ''
      }${pnlPercent.toFixed(2)}%`,
    );
    console.log(`   🎯 Action: COPY EXIT (early phase)`);

    return {
      shouldExit: true,
      phase: 'phase1',
      reason: 'wallet_exit_early',
      description: `Tracked wallet sold in first 3 minutes`,
      priority: 2,
    };
  }

  if (
    holdTime >= WALLET_EXIT_WINDOW &&
    holdTime < LOSS_PROTECTION_WINDOW
  ) {
    if (pnlPercent < 0) {
      console.log(`\n🛡️ PHASE 2: WALLET EXIT + LOSS PROTECTION`);
      console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
      console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
      console.log(
        `   Current PnL: ${pnlPercent.toFixed(2)}% (NEGATIVE)`,
      );
      console.log(`   🎯 Action: COPY EXIT (protect loss)`);

      return {
        shouldExit: true,
        phase: 'phase2',
        reason: 'wallet_exit_loss_protection',
        description: `Wallet sold and position is negative (${pnlPercent.toFixed(
          2,
        )}%)`,
        priority: 2,
      };
    } else {
      console.log(`\n✋ PHASE 2: WALLET SOLD BUT HOLDING`);
      console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
      console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
      console.log(
        `   Current PnL: +${pnlPercent.toFixed(2)}% (POSITIVE)`,
      );
      console.log(
        `   🎯 Action: IGNORE wallet exit, use trailing stop`,
      );

      return { shouldExit: false, phase: 'phase2_holding' };
    }
  }

  if (holdTime >= INDEPENDENT_MODE_TIME) {
    console.log(`\n✅ PHASE 3: INDEPENDENT MODE`);
    console.log(
      `   Hold time: ${Math.floor(holdTime / 60000)} minutes`,
    );
    console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
    console.log(
      `   Current PnL: ${
        pnlPercent >= 0 ? '+' : ''
      }${pnlPercent.toFixed(2)}%`,
    );
    console.log(
      `   🎯 Action: IGNORE wallet exit, using trailing stop`,
    );

    return { shouldExit: false, phase: 'phase3_independent' };
  }

  return { shouldExit: false, phase: 'unknown' };
}

// --- Procesador de señales de compra ---
//
// IMPORTANTE: ahora en DRY_RUN simulamos la compra y aún así abrimos
// posición en PositionManager para poder trackear PnL y estadísticas.
//

async function processCopySignals(): Promise<void> {
  console.log('🎯 Copy signals processor started\n');

  while (true) {
    try {
      const signalJson = (await Promise.race([
        redis.lpop('copy_signals'),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ])) as string | null;

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const copySignal = JSON.parse(signalJson) as CopySignal;

      console.log(
        `\n🔥 Processing copy signal from ${copySignal.walletName}`,
      );
      console.log(`   Mint: ${copySignal.mint.slice(0, 8)}...`);
      console.log(`   Upvotes: ${copySignal.upvotes}`);

      const decision = (await copyStrategy.shouldCopy(
        copySignal as any,
      )) as CopyDecision;

      if (!decision.copy) {
        console.log(`   ❌ Copy rejected: ${decision.reason}\n`);
        continue;
      }

      const priceData = await priceService.getPrice(
        copySignal.mint,
        true,
      );

      if (!priceData || !priceData.price) {
        console.log(`   ❌ Could not get price\n`);
        continue;
      }

      const currentPrice = priceData.price;

      console.log(`   💰 Executing ${decision.mode} trade...`);
      console.log(`   💵 Price: $${currentPrice.toFixed(10)}`);
      console.log(
        `   📊 Amount: ${decision.amount.toFixed(4)} SOL`,
      );

      if (!positionManager) {
        console.log('   ⚠️ No PositionManager available\n');
        continue;
      }

      // --- DRY_RUN: simulamos la compra sin tocar la blockchain ---
      if (DRY_RUN || !tradeExecutor || !ENABLE_TRADING) {
        const solAmount = decision.amount;
        const tokensSimulated = solAmount / currentPrice; // aproximado, suficiente para PnL

        await positionManager.openPosition(
          copySignal.mint,
          'COPY',
          currentPrice,
          solAmount,
          tokensSimulated,
          'DRY_RUN_BUY',
        );

        await redis.hset(`position:${copySignal.mint}`, {
          strategy: 'copy',
          walletSource: copySignal.walletAddress,
          walletName: copySignal.walletName,
          upvotes: decision.upvotes.toString(),
          buyers: JSON.stringify(decision.buyers),
          originalSignature: copySignal.signature,
          originalDex: copySignal.dex,
          executedDex: 'PAPER',
          confidence: decision.confidence.toString(),
          exitStrategy: 'hybrid_smart_exit',
          mode: 'DRY',
          entrySource: 'COPY',
          dex: copySignal.dex ?? 'PUMPFUN',
          strategyTag: 'ADAPTIVE',
        });

        await redis.setex(`copy_cooldown:${copySignal.mint}`, 60, '1');

        if (TELEGRAM_OWNER_CHAT_ID) {
          try {
            const confidenceEmoji =
              decision.confidence >= 80
                ? '🔥'
                : decision.confidence >= 60
                ? '🟢'
                : '🟡';

            await sendTelegramAlert(
              TELEGRAM_OWNER_CHAT_ID,
              `${confidenceEmoji} SMART COPY BUY (DRY-RUN)\n\n` +
                `Trader: ${copySignal.walletName}\n` +
                `Token: ${copySignal.mint.slice(0, 16)}...\n` +
                `\n` +
                `Price: $${currentPrice.toFixed(10)}\n` +
                `Amount: ${decision.amount.toFixed(4)} SOL\n` +
                `Tokens (sim): ${tokensSimulated.toFixed(2)}\n` +
                `\n` +
                `Upvotes: ${decision.upvotes} wallet(s)\n` +
                `Confidence: ${decision.confidence}%\n` +
                `\n` +
                `🎯 HYBRID Exit Strategy (DRY):\n` +
                `• 0-3 min: Copy wallet exits\n` +
                `• 3-10 min: Copy only on loss\n` +
                `• 10+ min: Independent trading\n` +
                `• Take Profit: +${COPY_PROFIT_TARGET_PERCENT}%\n` +
                `• Trailing Stop: -${TRAILING_STOP_PERCENT}%\n` +
                `• Stop Loss: -${COPY_STOP_LOSS_PERCENT}%`,
              false,
            );
          } catch {
            console.log('⚠️ Telegram notification failed');
          }
        }

        console.log('   ✅ DRY-RUN POSITION OPENED (simulated)\n');
        continue;
      }

      // --- LIVE MODE: usamos MultiDexExecutor ---
      if (ENABLE_TRADING && tradeExecutor && positionManager) {
        const buyResult = await tradeExecutor.buyToken(
          copySignal.mint,
          decision.amount,
          'auto',
        );

        if (buyResult.success) {
          const tokensReceived = buyResult.tokensReceived ?? 0;

          if (tokensReceived <= 0) {
            console.log(
              '   ⚠️ Buy marked as success pero tokensReceived es 0/undefined, NO se abre posición\n',
            );
            continue;
          }

          const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          console.log(
            `${mode} BUY EXECUTED on ${buyResult.dex ?? 'Unknown DEX'}`,
          );
          console.log(`   Tokens: ${tokensReceived}`);
          console.log(`   Signature: ${buyResult.signature}\n`);

          await positionManager.openPosition(
            copySignal.mint,
            'COPY',
            currentPrice,
            decision.amount,
            tokensReceived,
            buyResult.signature ?? 'UNKNOWN_SIGNATURE',
          );

          await redis.hset(`position:${copySignal.mint}`, {
            strategy: 'copy',
            walletSource: copySignal.walletAddress,
            walletName: copySignal.walletName,
            upvotes: decision.upvotes.toString(),
            buyers: JSON.stringify(decision.buyers),
            originalSignature: copySignal.signature,
            originalDex: copySignal.dex,
            executedDex: buyResult.dex,
            confidence: decision.confidence.toString(),
            exitStrategy: 'hybrid_smart_exit',
            mode: DRY_RUN ? 'DRY' : 'LIVE',
            entrySource: 'COPY',
            dex: buyResult.dex ?? copySignal.dex ?? 'UNKNOWN',
            strategyTag: 'ADAPTIVE',
          });

          await redis.setex(
            `copy_cooldown:${copySignal.mint}`,
            60,
            '1',
          );

          if (TELEGRAM_OWNER_CHAT_ID) {
            try {
              const confidenceEmoji =
                decision.confidence >= 80
                  ? '🔥'
                  : decision.confidence >= 60
                  ? '🟢'
                  : '🟡';

              const dexEmoji =
                buyResult.dex === 'Pump.fun'
                  ? '🚀'
                  : buyResult.dex === 'Raydium'
                  ? '⚡'
                  : buyResult.dex === 'Jupiter'
                  ? '🪐'
                  : buyResult.dex === 'Orca'
                  ? '🐋'
                  : '💱';

              await sendTelegramAlert(
                TELEGRAM_OWNER_CHAT_ID,
                `${confidenceEmoji} SMART COPY BUY\n\n` +
                  `Trader: ${copySignal.walletName}\n` +
                  `Token: ${copySignal.mint.slice(0, 16)}...\n` +
                  `\n` +
                  `${dexEmoji} Bought on: ${
                    buyResult.dex ?? 'Unknown'
                  }\n` +
                  `${
                    copySignal.dex &&
                    copySignal.dex !== buyResult.dex
                      ? `Original DEX: ${copySignal.dex}\n`
                      : ''
                  }` +
                  `Price: $${currentPrice.toFixed(10)}\n` +
                  `Amount: ${decision.amount.toFixed(4)} SOL\n` +
                  `\n` +
                  `Upvotes: ${decision.upvotes} wallet(s)\n` +
                  `Confidence: ${decision.confidence}%\n` +
                  `\n` +
                  `🎯 HYBRID Exit Strategy:\n` +
                  `• 0-3 min: Copy wallet exits\n` +
                  `• 3-10 min: Copy only on loss\n` +
                  `• 10+ min: Independent trading\n` +
                  `• Take Profit: +${COPY_PROFIT_TARGET_PERCENT}%\n` +
                  `• Trailing Stop: -${TRAILING_STOP_PERCENT}%\n` +
                  `• Stop Loss: -${COPY_STOP_LOSS_PERCENT}%`,
                false,
              );
            } catch {
              console.log('⚠️ Telegram notification failed');
            }
          }
        } else {
          console.log(`❌ BUY FAILED: ${buyResult.error}\n`);
        }
      }
    } catch (error: any) {
      console.error(
        '❌ Error processing copy signal:',
        error?.message ?? String(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// --- Procesador de señales de venta ---

async function processSellSignals(): Promise<void> {
  while (true) {
    try {
      const signalJson = (await redis.lpop(
        'sell_signals',
      )) as string | null;

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const sellSignal = JSON.parse(signalJson) as SellSignal;
      const { mint, sellCount } = sellSignal;

      console.log(
        `\n📉 Processing sell signal for ${mint.slice(0, 8)}...`,
      );
      console.log(`   Sellers: ${sellCount}`);

      const hasPosition = await redis.sismember('open_positions', mint);

      if (!hasPosition) {
        console.log(`   ⭕️ No position in this token\n`);
        continue;
      }

      const position = (await redis.hgetall(
        `position:${mint}`,
      )) as unknown as Position;

      if (!position || position.strategy !== 'copy') {
        continue;
      }

      const minToSell = COPY_MIN_WALLETS_TO_SELL;

      if (sellCount >= minToSell) {
        console.log(
          `   🚨 ${sellCount}/${minToSell} wallets sold - FLAGGING FOR REVIEW`,
        );

        await redis.setex(
          `multiple_sellers:${mint}`,
          30,
          sellCount.toString(),
        );

        if (TELEGRAM_OWNER_CHAT_ID) {
          try {
            await sendTelegramAlert(
              TELEGRAM_OWNER_CHAT_ID,
              `⚠️ MULTIPLE TRADERS SELLING\n\n` +
                `Token: ${mint.slice(0, 16)}...\n` +
                `Sellers: ${sellCount}/${minToSell} wallets\n` +
                `\n` +
                `Hybrid strategy will evaluate exit...`,
              false,
            );
          } catch {
            /* ignore */
          }
        }
      } else {
        console.log(
          `   ⏳ Only ${sellCount}/${minToSell} wallets sold - waiting\n`,
        );
      }
    } catch (error: any) {
      console.error(
        '❌ Error processing sell signal:',
        error?.message ?? String(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// --- Monitor de posiciones abiertas ---
//
// En DRY_RUN, el monitoreo usa precios del PriceService y al cerrar
// simulamos la venta sin enviar transacciones.
//

async function monitorOpenPositions(): Promise<void> {
  const lastUpdate: Record<string, number> = {};

  while (true) {
    try {
      if (!positionManager) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const openPositions = await positionManager.getOpenPositions();

      if (!openPositions || openPositions.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      for (const position of openPositions) {
        // Para el bot sniper más adelante podremos usar otras estrategias
        // aquí seguimos tratando solo las posiciones COPY con HYBRID exit
        const tokensAmount = parseInt(position.tokensAmount, 10);
        const valueData = await calculateCurrentValue(
          position.mint,
          tokensAmount,
        );

        if (!valueData) {
          console.log(
            `   ⚠️ Could not get current value for ${position.mint.slice(
              0,
              8,
            )}`,
          );
          continue;
        }

        const currentPrice = valueData.marketPrice;
        const entryPrice = parseFloat(position.entryPrice);
        const solSpent = parseFloat(position.solAmount);

        const currentSolValue = valueData.solValue;
        const pnlSOL = currentSolValue - solSpent;
        const pnlPercent = (pnlSOL / solSpent) * 100;

        const maxPrice = parseFloat(
          position.maxPrice || position.entryPrice,
        );
        if (currentPrice > maxPrice) {
          await positionManager.updateMaxPrice(
            position.mint,
            currentPrice,
          );
        }

        const now = Date.now();
        const lastUpd = lastUpdate[position.mint] || 0;

        if (LIVE_UPDATES && now - lastUpd >= 5000) {
          await sendPnLUpdate(
            position,
            currentPrice,
            pnlPercent,
            currentSolValue,
          );
          lastUpdate[position.mint] = now;
        }

        const forceExit = await redis.get(
          `force_exit:${position.mint}`,
        );

        if (forceExit) {
          await redis.del(`force_exit:${position.mint}`);

          console.log(`\n🎓 FORCE EXIT: Graduation detected`);
          console.log(`   Reason: ${forceExit}`);
          console.log(
            `   PnL: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(`   Priority: 1 (Graduation override)\n`);

          await executeSell(
            position,
            currentPrice,
            currentSolValue,
            forceExit,
          );
          continue;
        }

        // HYBRID exit solo tiene sentido para posiciones que vienen de wallets
        const hybridExit =
          position.strategy === 'copy'
            ? await evaluateHybridExit(
                position,
                currentPrice,
                pnlPercent,
                currentSolValue,
              )
            : { shouldExit: false, phase: 'none' };

        if (hybridExit.shouldExit) {
          console.log(
            `\n🎯 HYBRID EXIT: ${
              hybridExit.reason?.toUpperCase() ?? 'UNKNOWN'
            }`,
          );
          console.log(`   ${hybridExit.description ?? ''}`);
          console.log(`   Phase: ${hybridExit.phase}`);
          console.log(
            `   PnL: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(
            `   Priority: ${
              hybridExit.priority !== undefined
                ? hybridExit.priority
                : 'N/A'
            }\n`,
          );

          await executeSell(
            position,
            currentPrice,
            currentSolValue,
            hybridExit.reason ?? 'hybrid_exit',
          );
          continue;
        }

        const exitDecision = (await copyStrategy.shouldExit(
          position as any,
          currentPrice,
        )) as ExitDecision;

        if (exitDecision.exit) {
          console.log(
            `\n🚪 EXIT SIGNAL: ${exitDecision.reason?.toUpperCase()}`,
          );
          console.log(`   ${exitDecision.description}`);
          console.log(
            `   PnL: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(
            `   Priority: ${
              exitDecision.priority !== undefined
                ? exitDecision.priority
                : 'N/A'
            }\n`,
          );

          await executeSell(
            position,
            currentPrice,
            currentSolValue,
            exitDecision.reason ?? 'exit',
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error: any) {
      console.error(
        '❌ Error monitoring positions:',
        error?.message ?? String(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// --- Ejecución de venta ---
//
// En DRY_RUN simulamos la venta usando el valor actual (currentSolValue)
// sin enviar ninguna transacción. En LIVE usamos MultiDexExecutor.
//

async function executeSell(
  position: Position,
  currentPrice: number,
  currentSolValue: number,
  reason: string,
): Promise<void> {
  try {
    if (!positionManager) return;

    const tokens = parseInt(position.tokensAmount, 10);

    // --- DRY_RUN: cerrar posición simulando salida a currentSolValue ---
    if (DRY_RUN || !tradeExecutor || !ENABLE_TRADING) {
      const closedPosition = (await positionManager.closePosition(
        position.mint,
        currentPrice,
        tokens,
        currentSolValue,
        reason,
        'DRY_RUN_SELL',
      )) as ClosedPosition | null;

      await redis.del(
        `wallet_sold:${position.walletSource}:${position.mint}`,
      );

      if (TELEGRAM_OWNER_CHAT_ID && closedPosition) {
        try {
          const pnlSol = parseFloat(closedPosition.pnlSOL);
          const pnlPercent = parseFloat(closedPosition.pnlPercent);
          const emoji = pnlSol >= 0 ? '✅' : '❌';
          const mode2 = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          const holdTime = (
            (Date.now() - parseInt(position.entryTime, 10)) /
            1000
          ).toFixed(0);
          const entryPrice = parseFloat(position.entryPrice);

          const reasonMap: Record<string, string> = {
            wallet_exit_early: '⚡ Phase 1: Wallet Exit (0-3 min)',
            wallet_exit_loss_protection:
              '🛡️ Phase 2: Wallet Exit + Loss Protection',
            take_profit: '💰 Take Profit',
            trailing_stop: '📉 Trailing Stop',
            stop_loss: '🛑 Stop Loss',
            traders_sold: '💼 Multiple Traders Sold',
            traders_sold_auto: '💼 Traders Auto-Sell',
            max_hold_time: '⏱️ Max Hold Time',
            manual_sell: '👤 Manual Sell',
          };

          const exitReason =
            reasonMap[reason] ?? reason.toUpperCase();

          await sendTelegramAlert(
            TELEGRAM_OWNER_CHAT_ID,
            `${emoji} ${mode2} EXIT (DRY-RUN): ${exitReason}\n\n` +
              `Trader: ${
                position.walletName || 'Unknown'
              }\n` +
              `Token: ${position.mint.slice(0, 16)}...\n` +
              `Hold: ${holdTime}s\n` +
              `\n` +
              `Entry: ${entryPrice.toFixed(10)}\n` +
              `Exit: ${currentPrice.toFixed(10)}\n` +
              `\n` +
              `PnL: ${pnlPercent.toFixed(2)}% ` +
              `(${pnlSol.toFixed(4)} SOL)`,
            false,
          );
        } catch {
          /* ignore */
        }
      }

      console.log(
        `📄 PAPER SELL (simulado) ejecutado para ${position.mint.slice(
          0,
          10,
        )}...`,
      );
      return;
    }

    // --- LIVE: usar MultiDexExecutor ---
    if (!tradeExecutor) return;

    const sellResult = await tradeExecutor.sellToken(
      position.mint,
      tokens,
      'auto',
    );

    if (sellResult.success) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      const usedDex =
        sellResult.dex ?? position.executedDex ?? 'Unknown';

      console.log(
        `${mode} SELL EXECUTED on ${usedDex}`,
      );
      console.log(
        `   SOL received: ${sellResult.solReceived}`,
      );
      console.log(`   Signature: ${sellResult.signature}\n`);

      const closedPosition = (await positionManager.closePosition(
        position.mint,
        currentPrice,
        tokens,
        sellResult.solReceived ?? currentSolValue,
        reason,
        sellResult.signature,
      )) as ClosedPosition | null;

      await redis.del(
        `wallet_sold:${position.walletSource}:${position.mint}`,
      );

      if (
        TELEGRAM_OWNER_CHAT_ID &&
        closedPosition
      ) {
        try {
          const pnlSol = parseFloat(closedPosition.pnlSOL);
          const pnlPercent = parseFloat(
            closedPosition.pnlPercent,
          );
          const emoji = pnlSol >= 0 ? '✅' : '❌';
          const mode2 = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          const holdTime = (
            (Date.now() - parseInt(position.entryTime, 10)) /
            1000
          ).toFixed(0);
          const entryPrice = parseFloat(position.entryPrice);

          const reasonMap: Record<string, string> = {
            wallet_exit_early: '⚡ Phase 1: Wallet Exit (0-3 min)',
            wallet_exit_loss_protection:
              '🛡️ Phase 2: Wallet Exit + Loss Protection',
            take_profit: '💰 Take Profit',
            trailing_stop: '📉 Trailing Stop',
            stop_loss: '🛑 Stop Loss',
            traders_sold: '💼 Multiple Traders Sold',
            traders_sold_auto: '💼 Traders Auto-Sell',
            max_hold_time: '⏱️ Max Hold Time',
            manual_sell: '👤 Manual Sell',
          };

          const exitReason =
            reasonMap[reason] ?? reason.toUpperCase();

          await sendTelegramAlert(
            TELEGRAM_OWNER_CHAT_ID,
            `${emoji} ${mode2} EXIT: ${exitReason}\n\n` +
              `Trader: ${
                position.walletName || 'Unknown'
              }\n` +
              `Token: ${position.mint.slice(0, 16)}...\n` +
              `Hold: ${holdTime}s\n` +
              `\n` +
              `Entry: ${entryPrice.toFixed(10)}\n` +
              `Exit: ${currentPrice.toFixed(10)}\n` +
              `\n` +
              `PnL: ${pnlPercent.toFixed(2)}% ` +
              `(${pnlSol.toFixed(4)} SOL)`,
            false,
          );
        } catch {
          /* ignore */
        }
      }
    } else {
      console.log(`❌ SELL FAILED: ${sellResult.error}\n`);
    }
  } catch (error: any) {
    console.error(
      '❌ Error executing sell:',
      error?.message ?? String(error),
    );
  }
}

// ✅ sendPnLUpdate

async function sendPnLUpdate(
  position: Position,
  currentPrice: number,
  pnlPercent: number,
  currentSolValue: number,
): Promise<void> {
  const chatId = TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return;

  try {
    const entryPrice = parseFloat(position.entryPrice);
    const maxPrice = parseFloat(position.maxPrice || entryPrice.toString());
    const holdTime = (
      (Date.now() - parseInt(position.entryTime, 10)) /
      1000
    ).toFixed(0);
    const upvotes = parseInt(position.upvotes || '1', 10);
    const solSpent = parseFloat(position.solAmount);
    const pnlSOL = currentSolValue - solSpent;

    const sellCount =
      (await redis.scard(
        `upvotes:${position.mint}:sellers`,
      )) || 0;
    const minToSell = COPY_MIN_WALLETS_TO_SELL;

    const holdTimeMs = Date.now() - parseInt(position.entryTime, 10);
    let phaseInfo = '';
    if (holdTimeMs < WALLET_EXIT_WINDOW) {
      phaseInfo = '⚡ Phase 1: Following wallet';
    } else if (holdTimeMs < LOSS_PROTECTION_WINDOW) {
      phaseInfo =
        pnlPercent < 0
          ? '🛡️ Phase 2: Loss protection active'
          : '🟢 Phase 2: Letting it run';
    } else {
      phaseInfo = '🚀 Phase 3: Independent mode';
    }

    const emoji =
      pnlPercent >= 20
        ? '🚀'
        : pnlPercent >= 10
        ? '📈'
        : pnlPercent >= 0
        ? '🟢'
        : pnlPercent >= -5
        ? '🟡'
        : '🔴';

    await sendTelegramAlert(
      chatId,
      `${emoji} P&L UPDATE\n\n` +
        `Mint: ${position.mint.slice(0, 16)}...\n` +
        `Entry: $${entryPrice.toFixed(10)}\n` +
        `Current: $${currentPrice.toFixed(10)}\n` +
        `Max: $${maxPrice.toFixed(10)}\n` +
        `\n` +
        `💰 PnL: ${
          pnlPercent >= 0 ? '+' : ''
        }${pnlPercent.toFixed(2)}% ` +
        `(${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL)\n` +
        `⏱️ Hold: ${holdTime}s\n` +
        `🎯 Upvotes: ${upvotes}\n` +
        `📉 Sellers: ${sellCount}/${minToSell}\n` +
        `\n` +
        `${phaseInfo}`,
      true,
    );
  } catch {
    /* ignore */
  }
}

// --- Logging periódico de estado ---

setInterval(async () => {
  try {
    const openPositions = await redis.scard('open_positions');
    const pendingSignals = await redis.llen('copy_signals');

    if (openPositions > 0 || pendingSignals > 0) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      console.log(
        `\n${mode} - Positions: ${openPositions} | Pending: ${pendingSignals}\n`,
      );
    }
  } catch {
    /* ignore */
  }
}, 60000);

console.log('🚀 Copy Monitor HYBRID strategy started');
console.log(
  `   Mode: ${DRY_RUN ? '📄 PAPER TRADING' : '💰 LIVE TRADING'}`,
);
console.log('   ✅ Pump.fun 14 accounts + Jupiter via MultiDexExecutor');
console.log('   🎯 HYBRID exit: Phase 1-3 with trailing stop\n');

Promise.all([
  processCopySignals(),
  processSellSignals(),
  monitorOpenPositions(),
]).catch((error) => {
  console.error(
    '❌ Copy monitor crashed:',
    (error as Error)?.message ?? String(error),
  );
  process.exit(1);
});
