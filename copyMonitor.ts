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
  VOLUME_EXIT_ENABLED,
  VOLUME_DROP_PERCENT,
  VOLUME_WINDOW_SECONDS,
  VOLUME_MIN_HOLD_SECONDS,
  PARTIAL_TP_ENABLED,
  PARTIAL_TP1_PCT,
  PARTIAL_TP1_SELL_PCT,
  PARTIAL_TP2_PCT,
  PARTIAL_TP2_SELL_PCT,
  PARTIAL_TP3_PCT,
  PARTIAL_TP3_SELL_PCT,
} from './environment.js';

// En vez de usar PumpFunExecutor directo, usamos MultiDexExecutor que ya maneja:
// - Pump.fun 14 cuentas
// - Jupiter (Ultra Swap vía JupiterSdkExecutor)
// - BLOQUEO de venta en Pump.fun si el token está graduado
import {
  MultiDexExecutor,
  type BuyResult,
  type SellResult,
} from './multiDexExecutor.js';

import { PositionManager, type Position } from './riskManager.js';
import { createRedisClient, type RedisClient as RedisWrapper } from './redisClient.js';

// --- Tipos auxiliares internos ---

interface CopySignal {
  signature: string;
  wallet: string;
  walletName?: string;
  mint: string;
  amountSol: number;
  txType: 'buy' | 'sell';
  timestamp: number;
  isCreator?: boolean;
  copyPercentage?: number;
  upvotes?: number;
}

interface WalletSellInfo {
  walletsSelling: Set<string>;
  lastSellAt: number;
  minEntryAt: number;
}

interface ExitContext {
  mint: string;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  pnlSOL: number;
  holdTimeMs: number;
  solValue: number;
}

// HYBRID exit reasons
type HybridExitPhase =
  | 'none'
  | 'copy_wallets'
  | 'loss_protection'
  | 'independent_time'
  | 'volume_exit';

interface HybridExitDecision {
  shouldExit: boolean;
  phase: HybridExitPhase;
  reason?: string;
  description?: string;
  priority?: number;
  walletsSelling?: number;
  totalWalletsTracked?: number;
  stopType?: 'take_profit' | 'stop_loss' | 'trailing_stop';
}

// --- Estado global ligero ---

let redisClient: RedisClient | null = null;
let redisWrapper: RedisWrapper | null = null;
let connection: Connection | null = null;
let priceService: PriceService | null = null;
let copyStrategy: CopyStrategy;
let positionManager: PositionManager;
let tradeExecutor: MultiDexExecutor | null = null;

let isMonitoring = false;
let isInitialized = false;

// Map mint -> WalletSellInfo (para HYBRID exits)
const walletSellState: Map<string, WalletSellInfo> = new Map();

// Estadísticas sencillas
let processedSignals = 0;
let ignoredSignals = 0;

const DRY_RUN = isDryRunEnabled();
const LIVE_UPDATES = TELEGRAM_LIVE_UPDATES_ENABLED;

// 🎯 HYBRID STRATEGY CONFIG
const WALLET_EXIT_WINDOW = 180000; // 3 minutes
const LOSS_PROTECTION_WINDOW = 600000; // 10 minutes
const INDEPENDENT_MODE_TIME = 600000; // After 10 min

// 💧 VOLUME EXIT CONFIG
const VOLUME_EXIT = VOLUME_EXIT_ENABLED;
const VOLUME_DROP = VOLUME_DROP_PERCENT; // e.g. 70 => 70% drop vs. peak activity
const VOLUME_WINDOW_MS = VOLUME_WINDOW_SECONDS * 1000;
const VOLUME_MIN_HOLD_MS = VOLUME_MIN_HOLD_SECONDS * 1000;

// 📊 PARTIAL TAKE PROFIT CONFIG
const PARTIAL_TP = PARTIAL_TP_ENABLED;
const PARTIAL_LEVELS = [
  { level: 1, tp: PARTIAL_TP1_PCT, sellPct: PARTIAL_TP1_SELL_PCT },
  { level: 2, tp: PARTIAL_TP2_PCT, sellPct: PARTIAL_TP2_SELL_PCT },
  { level: 3, tp: PARTIAL_TP3_PCT, sellPct: PARTIAL_TP3_SELL_PCT },
].filter((l) => l.tp > 0 && l.sellPct > 0);

// --- Seguimiento simple de "volumen" basado en actividad de precio ---
// No usamos volumen on-chain real; usamos la velocidad de cambio de precio
// como proxy de actividad. Si la "velocidad" cae X% vs el máximo reciente,
// durante una ventana de tiempo, disparamos señal de salida.
interface VolumeState {
  lastPrice: number;
  lastTs: number;
  peakVelocity: number;
  lastPeakTs: number;
}

const volumeState: Record<string, VolumeState> = {};

function updateVolumeAndCheckExit(
  mint: string,
  currentPrice: number,
  holdTimeMs: number,
): HybridExitDecision {
  if (!VOLUME_EXIT || currentPrice <= 0) {
    return { shouldExit: false, phase: 'none' };
  }

  const now = Date.now();
  const state: VolumeState = volumeState[mint] ?? {
    lastPrice: currentPrice,
    lastTs: now,
    peakVelocity: 0,
    lastPeakTs: now,
  };

  const dtMs = now - state.lastTs;
  if (dtMs <= 0) {
    volumeState[mint] = state;
    return { shouldExit: false, phase: 'none' };
  }

  const dtSec = dtMs / 1000;
  const priceDelta = Math.abs(currentPrice - state.lastPrice);
  const velocity =
    (priceDelta / Math.max(currentPrice, 1e-9)) / Math.max(dtSec, 1e-3);

  if (velocity > state.peakVelocity) {
    state.peakVelocity = velocity;
    state.lastPeakTs = now;
  }

  state.lastPrice = currentPrice;
  state.lastTs = now;
  volumeState[mint] = state;

  if (holdTimeMs < VOLUME_MIN_HOLD_MS) {
    return { shouldExit: false, phase: 'none' };
  }

  if (state.peakVelocity <= 0) {
    return { shouldExit: false, phase: 'none' };
  }

  const dropRatio = velocity / state.peakVelocity;
  const threshold = 1 - VOLUME_DROP / 100;
  const timeSincePeak = now - state.lastPeakTs;

  if (dropRatio <= threshold && timeSincePeak >= VOLUME_WINDOW_MS) {
    const dropPct = (1 - dropRatio) * 100;

    return {
      shouldExit: true,
      phase: 'volume_exit',
      reason: 'volume_dry_up',
      description: `Price activity dropped ${dropPct.toFixed(
        1,
      )}% vs peak`,
      priority: 3,
    };
  }

  return { shouldExit: false, phase: 'none' };
}

// --- Inicialización compartida ---

async function initCore() {
  if (isInitialized) return;
  if (!redisClient) {
    redisClient = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });
  }
  redisWrapper = createRedisClient();
  connection = new Connection(process.env.RPC_URL as string, 'confirmed');
  priceService = getPriceService();

  const key = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;

  if (!key || !rpcUrl) {
    console.log('⚠️ PRIVATE_KEY or RPC_URL not set, disabling trading');
    tradeExecutor = null;
  } else {
    tradeExecutor = new MultiDexExecutor(key, rpcUrl, DRY_RUN);
  }

  positionManager = new PositionManager(redisClient as RedisClient);
  copyStrategy = new CopyStrategy({
    positionManager,
    priceService,
    redis: redisClient as RedisClient,
  });

  isInitialized = true;
}

// --- HYBRID EXIT LOGIC (ya tenías esto) ---

async function evaluateHybridExit(
  position: Position,
  currentPrice: number,
  pnlPercent: number,
  solValue: number,
): Promise<HybridExitDecision> {
  if (!priceService) {
    return { shouldExit: false, phase: 'none' };
  }

  const now = Date.now();
  const holdTimeMs = now - Number(position.entryTime ?? now);
  const holdTimeMinutes = holdTimeMs / 60000;

  const mint = position.mint;
  const ws = walletSellState.get(mint);

  const exitContext: ExitContext = {
    mint,
    entryPrice: Number(position.entryPrice),
    currentPrice,
    pnlPercent,
    pnlSOL:
      ((currentPrice - Number(position.entryPrice)) /
        Number(position.entryPrice)) *
      Number(position.solAmount ?? '0'),
    holdTimeMs,
    solValue,
  };

  // HYBRID exit: copy wallets conditions
  if (ws && ws.walletsSelling.size >= COPY_MIN_WALLETS_TO_SELL) {
    const timeSinceFirstSell = now - ws.minEntryAt;
    if (timeSinceFirstSell <= WALLET_EXIT_WINDOW) {
      return {
        shouldExit: true,
        phase: 'copy_wallets',
        reason: 'copy_sell',
        description: `Copy wallets selling: ${ws.walletsSelling.size} wallets in ${Math.round(
          timeSinceFirstSell / 1000,
        )}s`,
        priority: 1,
        walletsSelling: ws.walletsSelling.size,
      };
    }
  }

  // Protección contra pérdidas directas (stop-loss o trailing)
  if (holdTimeMs <= LOSS_PROTECTION_WINDOW) {
    if (pnlPercent <= -Math.abs(COPY_STOP_LOSS_PERCENT)) {
      return {
        shouldExit: true,
        phase: 'loss_protection',
        reason: 'hybrid_stop_loss',
        description: `PnL below hard SL (${COPY_STOP_LOSS_PERCENT}%) during protection window`,
        priority: 2,
        stopType: 'stop_loss',
      };
    }

    if (pnlPercent >= COPY_PROFIT_TARGET_PERCENT) {
      return {
        shouldExit: true,
        phase: 'loss_protection',
        reason: 'hybrid_take_profit',
        description: `PnL hit hybrid TP (${COPY_PROFIT_TARGET_PERCENT}%) during protection window`,
        priority: 2,
        stopType: 'take_profit',
      };
    }
  }

  // Después de cierto tiempo, permitir que el trailing domine
  if (holdTimeMs >= INDEPENDENT_MODE_TIME && TRAILING_STOP_PERCENT > 0) {
    const trailingDecision = await copyStrategy.evaluateTrailingStop(
      position,
      currentPrice,
      pnlPercent,
    );

    if (trailingDecision.shouldExit) {
      return {
        shouldExit: true,
        phase: 'independent_time',
        reason: 'hybrid_trailing_stop',
        description: trailingDecision.description,
        priority: 2,
        stopType: 'trailing_stop',
      };
    }
  }

  return { shouldExit: false, phase: 'none' };
}

// --- Procesador de señales de compra ---

async function processCopySignal(signal: CopySignal): Promise<void> {
  await initCore();
  if (!redisClient || !priceService) return;

  processedSignals++;

  if (!ENABLE_AUTO_TRADING) {
    ignoredSignals++;
    return;
  }

  if (signal.txType === 'sell') {
    await markWalletSold(signal);
    return;
  }

  if (!tradeExecutor) {
    ignoredSignals++;
    return;
  }

  const existingPosition = await positionManager.getPosition(signal.mint);
  if (existingPosition) {
    ignoredSignals++;
    return;
  }

  const priceData = await priceService.getPrice(signal.mint, true);
  if (!priceData || priceData.price === null) {
    ignoredSignals++;
    return;
  }

  const solAmount = POSITION_SIZE_SOL;
  const buyResult: BuyResult = await tradeExecutor.buyToken(
    signal.mint,
    solAmount,
    'pumpfun',
  );

  if (!buyResult.success) {
    ignoredSignals++;
    return;
  }

  const entryPrice = buyResult.effectivePrice ?? priceData.price;
  await positionManager.registerOpenPosition({
    mint: signal.mint,
    entryPrice,
    solAmount,
    tokensAmount: buyResult.tokensAmount ?? 0,
    walletName: signal.walletName ?? 'Copy wallet',
    strategy: 'copy',
    originalSignature: signal.signature,
    executedDex: buyResult.executedDex ?? 'pumpfun',
    entryTime: Date.now(),
    upvotes: signal.upvotes ?? 1,
  });

  if (LIVE_UPDATES && TELEGRAM_OWNER_CHAT_ID) {
    await sendTelegramAlert(
      TELEGRAM_OWNER_CHAT_ID,
      `🟢 COPY BUY\nWallet: ${signal.walletName ?? signal.wallet}\nMint: ${signal.mint.slice(
        0,
        12,
      )}...\nAmount: ${solAmount} SOL\nEntry: ${entryPrice.toFixed(8)}`,
      true,
    );
  }
}

// --- Marcado de ventas de wallets para HYBRID exit ---

async function markWalletSold(signal: CopySignal): Promise<void> {
  const mint = signal.mint;
  const now = Date.now();

  let ws = walletSellState.get(mint);
  if (!ws) {
    ws = {
      walletsSelling: new Set<string>(),
      lastSellAt: now,
      minEntryAt: now,
    };
    walletSellState.set(mint, ws);
  }

  ws.walletsSelling.add(signal.wallet);
  ws.lastSellAt = now;
}

// --- MONITOR de posiciones abiertas ---

async function calculateCurrentValue(
  position: Position,
): Promise<{ currentPrice: number; currentSolValue: number }> {
  if (!priceService) {
    throw new Error('priceService not initialized');
  }

  const mint = position.mint;
  const tokensAmount = Number(position.tokensAmount ?? '0');

  const valueData = await priceService.calculateCurrentValue(
    mint,
    tokensAmount,
  );

  if (!valueData || valueData.marketPrice === null) {
    return {
      currentPrice: Number(position.entryPrice),
      currentSolValue:
        (Number(position.entryPrice) || 0) * tokensAmount,
    };
  }

  return {
    currentPrice: valueData.marketPrice,
    currentSolValue: valueData.solValue,
  };
}

async function monitorOpenPositions() {
  await initCore();
  if (!redisClient || !priceService) return;

  if (isMonitoring) {
    return;
  }
  isMonitoring = true;

  console.log('📡 copyMonitor: monitoring open positions...');

  while (true) {
    try {
      const positions = await positionManager.getOpenPositions();
      for (const position of positions) {
        if (position.strategy !== 'copy') continue;

        const { currentPrice, currentSolValue } =
          await calculateCurrentValue(position);

        const entryPrice = Number(position.entryPrice);
        const pnlPercent =
          ((currentPrice - entryPrice) / entryPrice) * 100;
        const pnlSOL =
          ((currentPrice - entryPrice) / entryPrice) *
          Number(position.solAmount ?? '0');
        const holdTime = Date.now() - Number(position.entryTime ?? 0);

        // HYBRID exit
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

        // 💧 Volume-based exit (price activity drying up)
        const volumeExit = updateVolumeAndCheckExit(
          position.mint,
          currentPrice,
          holdTime,
        );

        if (volumeExit.shouldExit) {
          console.log(
            `\n💧 VOLUME EXIT: ${
              volumeExit.reason?.toUpperCase() ?? 'VOLUME_EXIT'
            }`,
          );
          if (volumeExit.description) {
            console.log(`   ${volumeExit.description}`);
          }
          console.log(
            `   PnL: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)\n`,
          );

          await executeSell(
            position,
            currentPrice,
            currentSolValue,
            volumeExit.reason ?? 'volume_exit',
          );
          continue;
        }

        // 🎯 Partial take-profits BEFORE generic exits
        if (PARTIAL_TP && !DRY_RUN && ENABLE_AUTO_TRADING && tradeExecutor) {
          const partialDone = await handlePartialTakeProfits(
            position,
            currentPrice,
            pnlPercent,
          );
          if (partialDone) {
            // Vendimos una parte; esperamos al siguiente ciclo para re-evaluar
            continue;
          }
        }

        const exitDecision = await copyStrategy.shouldExit(
          position,
          currentPrice,
          pnlPercent,
          currentSolValue,
        );

        if (exitDecision.shouldExit) {
          await executeSell(
            position,
            currentPrice,
            currentSolValue,
            exitDecision.reason,
          );
          continue;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err: any) {
      console.error(
        '⚠️ Error in monitorOpenPositions:',
        err?.message ?? String(err),
      );
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

// --- Ventas parciales escalonadas ---
//
// Usamos niveles configurables de TP para vender una fracción de la posición
// sin cerrar completamente la posición en Redis. Solo aplicamos en LIVE mode.
async function handlePartialTakeProfits(
  position: Position,
  currentPrice: number,
  pnlPercent: number,
): Promise<boolean> {
  try {
    if (!PARTIAL_TP || DRY_RUN || !ENABLE_AUTO_TRADING) {
      return false;
    }
    if (!tradeExecutor) {
      return false;
    }
    if (!redisClient) {
      return false;
    }

    if (!position.tokensAmount || !position.solAmount) {
      return false;
    }

    const totalTokens = Number(position.tokensAmount);
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
      return false;
    }

    const redis = redisClient;

    const stageKey = `tp_stage:${position.mint}`;
    const rawStage = await redis.get(stageKey);
    const currentStage = rawStage ? parseInt(rawStage, 10) || 0 : 0;

    // Busca el siguiente nivel aplicable
    const nextLevel = PARTIAL_LEVELS.find(
      (l) => l.level > currentStage && pnlPercent >= l.tp,
    );

    if (!nextLevel) {
      return false;
    }

    const fraction = Math.min(Math.max(nextLevel.sellPct / 100, 0), 1);
    const tokensToSell = Math.floor(totalTokens * fraction);

    if (tokensToSell <= 0 || tokensToSell >= totalTokens) {
      // Si por redondeo nos quedaríamos sin tokens, dejamos que el flujo normal haga la venta total.
      return false;
    }

    console.log(
      `\n🎯 PARTIAL TP L${nextLevel.level}: selling ${(
        fraction * 100
      ).toFixed(1)}% (${tokensToSell} tokens) at PnL ${pnlPercent.toFixed(
        2,
      )}%`,
    );

    const dexHint =
      position.executedDex && position.executedDex.length > 0
        ? position.executedDex
        : 'auto';

    const sellResult = await tradeExecutor.sellToken(
      position.mint,
      tokensToSell,
      dexHint as any,
    );

    if (!sellResult.success) {
      console.log(
        `⚠️ Partial TP L${nextLevel.level} failed: ${
          sellResult.error ?? 'Unknown error'
        }`,
      );
      return false;
    }

    // Actualizamos Redis con la nueva cantidad restante
    const remainingTokens = totalTokens - tokensToSell;
    const originalSolAmount = Number(position.solAmount ?? '0');

    let remainingSolAmount = originalSolAmount;
    if (originalSolAmount > 0 && totalTokens > 0) {
      remainingSolAmount =
        (originalSolAmount * remainingTokens) / totalTokens;
    }

    await redis.hset(`position:${position.mint}`, {
      tokensAmount: String(remainingTokens),
      solAmount: remainingSolAmount.toFixed(9),
    });
    await redis.set(stageKey, String(nextLevel.level), 'EX', 24 * 3600);

    const realizedSol =
      sellResult.solReceived ?? currentPrice * tokensToSell;

    if (TELEGRAM_OWNER_CHAT_ID) {
      const dir = pnlPercent >= 0 ? '🟢' : '🔴';
      await sendTelegramAlert(
        TELEGRAM_OWNER_CHAT_ID,
        `${dir} PARTIAL TP L${nextLevel.level}\n` +
          `Wallet: ${position.walletName ?? 'Copy wallet'}\n` +
          `Mint: ${position.mint.slice(0, 12)}...\n` +
          `Sold: ${tokensToSell} tokens (~${(
            (tokensToSell / totalTokens) *
            100
          ).toFixed(1)}%)\n` +
          `Realized: ${realizedSol.toFixed(4)} SOL\n` +
          `PnL: ${pnlPercent.toFixed(2)}%`,
        true,
      );
    }

    return true;
  } catch (err: any) {
    console.log(
      '⚠️ Error in handlePartialTakeProfits:',
      err?.message ?? String(err),
    );
    return false;
  }
}

// --- Ejecución de venta ---

async function executeSell(
  position: Position,
  currentPrice: number,
  currentSolValue: number,
  reason: string,
): Promise<void> {
  await initCore();
  if (!redisClient || !priceService) return;

  const dryRun = DRY_RUN;
  const mint = position.mint;
  const tokensAmount = Number(position.tokensAmount ?? '0');

  const reasonMap: Record<string, string> = {
    copy_sell: 'Copy wallets exit',
    hybrid_exit: 'Hybrid strategy exit',
    hybrid_stop_loss: 'Hybrid stop-loss',
    hybrid_take_profit: 'Hybrid take-profit',
    hybrid_trailing_stop: 'Hybrid trailing stop',
    stop_loss: 'Stop-loss',
    take_profit: 'Take-profit',
    trailing_stop: 'Trailing stop',
    max_hold_time: '⏱️ Max Hold Time',
    volume_dry_up: '💧 Volume dried up',
  };

  const reasonText =
    reasonMap[reason] ?? reason.replace(/_/g, ' ').toUpperCase();

  console.log(
    `\n💰 EXECUTE SELL [${dryRun ? 'PAPER' : 'LIVE'}] for mint ${mint}`,
  );

  if (!tradeExecutor || dryRun) {
    await positionManager.closePosition(
      mint,
      currentPrice,
      tokensAmount,
      currentSolValue,
      reason,
      undefined,
    );
    return;
  }

  const dexHint =
    position.executedDex && position.executedDex.length > 0
      ? position.executedDex
      : 'auto';

  const sellResult: SellResult = await tradeExecutor.sellToken(
    mint,
    tokensAmount,
    dexHint as any,
  );

  if (!sellResult.success) {
    console.log(
      `❌ Sell failed for mint ${mint}: ${
        sellResult.error ?? 'Unknown error'
      }`,
    );
    return;
  }

  const realizedSol =
    sellResult.solReceived ?? currentPrice * tokensAmount;

  await positionManager.closePosition(
    mint,
    currentPrice,
    tokensAmount,
    realizedSol,
    reason,
    sellResult.signature,
  );

  if (TELEGRAM_OWNER_CHAT_ID) {
    const entryPrice = Number(position.entryPrice);
    const pnlPercent =
      ((currentPrice - entryPrice) / entryPrice) * 100;
    const pnlSOL =
      ((currentPrice - entryPrice) / entryPrice) *
      Number(position.solAmount ?? '0');

    const dir = pnlPercent >= 0 ? '🟢' : '🔴';

    await sendTelegramAlert(
      TELEGRAM_OWNER_CHAT_ID,
      `${dir} EXIT (${reasonText})\n` +
        `Wallet: ${position.walletName ?? 'Copy wallet'}\n` +
        `Mint: ${mint.slice(0, 12)}...\n` +
        `Entry: ${entryPrice.toFixed(8)}\n` +
        `Exit: ${currentPrice.toFixed(8)}\n` +
        `PnL: ${pnlPercent.toFixed(2)}% | ${pnlSOL.toFixed(4)} SOL\n` +
        (sellResult.signature
          ? `Signature: ${sellResult.signature.slice(0, 12)}...`
          : ''),
      true,
    );
  }
}

// --- LOOP PÚBLICO ---

export async function startCopyMonitor(): Promise<void> {
  await initCore();
  monitorOpenPositions().catch(err => {
    console.error('❌ monitorOpenPositions crashed:', err);
  });
}
