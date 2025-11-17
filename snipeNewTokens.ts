// snipeNewTokens.ts - SNIPER ALL NEW TOKENS (Pump.fun / PumpPortal)

import 'dotenv/config';
import WebSocket from 'ws';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import { PublicKey } from '@solana/web3.js';

import {
  isDryRunEnabled,
  POSITION_SIZE_SOL,
  SNIPE_NEW_TOKENS,
  TOKEN_AGE_LIMIT_SECONDS,
  MIN_BUY_VOLUME_SOL,
  MAX_TOKENS_PER_HOUR,
} from './environment.js';

import { getPriceService } from './priceService.js';
import type { PriceData } from './priceService.js';
import { MultiDexExecutor } from './multiDexExecutor.js';
import { PositionManager } from './riskManager.js';
import { sendTelegramAlert } from './telegram.js';

// --- Tipos básicos ---

interface NewTokenEvent {
  mint: string;
  signature?: string;
  traderPublicKey?: string;
  txType?: string;
  initialBuy?: number;
  solAmount?: number;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  pool?: string;
  createdAt?: number | string | null;
}

interface SniperConfig {
  dryRun: boolean;
  positionSizeSol: number;
  tokenAgeLimitSeconds: number;
  minBuyVolumeSol: number;
  maxTokensPerHour: number;
}

let redis: RedisClient | null = null;
let ws: WebSocket | null = null;
let lastHourTimestamp = 0;
let tokensThisHour = 0;

const priceService = getPriceService();

// --- Normalizador de eventos (PumpPortal → NewTokenEvent interno) ---

function normalizeNewTokenEvent(raw: any): NewTokenEvent {
  const createdAt =
    raw.createdAt ??
    raw.CreatedAt ??
    raw.blockTime ??
    raw.BlockTime ??
    null;

  return {
    mint: raw.mint ?? raw.Mint ?? raw.tokenMint ?? raw.TokenMint ?? '',
    signature: raw.signature ?? raw.Signature ?? raw.sig ?? '',
    traderPublicKey:
      raw.traderPublicKey ?? raw.TraderPublicKey ?? raw.owner ?? raw.Owner ?? '',
    txType: raw.txType ?? raw.TxType ?? raw.type ?? '',
    initialBuy: raw.initialBuy ?? raw.InitialBuy ?? 0,
    solAmount: raw.solAmount ?? raw.SolAmount ?? 0,
    vTokensInBondingCurve:
      raw.vTokensInBondingCurve ?? raw.VTokensInBondingCurve ?? 0,
    vSolInBondingCurve:
      raw.vSolInBondingCurve ?? raw.VSolInBondingCurve ?? 0,
    marketCapSol: raw.marketCapSol ?? raw.MarketCapSol ?? 0,
    name: raw.name ?? raw.Name ?? '',
    symbol: raw.symbol ?? raw.Symbol ?? '',
    uri: raw.uri ?? raw.Uri ?? '',
    pool:
      raw.pool ??
      raw.Pool ??
      raw.bondingCurveKey ??
      raw.BondingCurveKey ??
      '',
    createdAt,
  };
}

// --- Helpers numéricos / validaciones ---

function getTokenAgeSeconds(evt: NewTokenEvent): number {
  const createdAt =
    evt.createdAt ??
    (typeof evt as any).launchTimestamp ??
    (typeof evt as any).firstSeen ??
    (typeof evt as any).created_at ??
    (typeof evt as any).launchTime ??
    null;

  if (!createdAt) return 0;

  const ms =
    typeof createdAt === 'number'
      ? createdAt * (createdAt > 10_000_000_000 ? 1 : 1000)
      : Date.parse(String(createdAt));

  if (!Number.isFinite(ms)) return 0;

  return (Date.now() - ms) / 1000;
}

function getInitialVolumeSol(evt: NewTokenEvent): number {
  const mcap =
    evt.marketCapSol ??
    (evt as any).marketCap ??
    (evt as any).market_cap ??
    0;
  const solAmount =
    evt.solAmount ??
    (evt as any).SolAmount ??
    (evt as any).sol_in ??
    0;

  if (mcap && Number.isFinite(mcap)) return mcap;
  if (solAmount && Number.isFinite(solAmount)) return solAmount;
  return 0;
}

function isLikelyPumpFunPool(evt: NewTokenEvent): boolean {
  const pool = evt.pool ?? (evt as any).bondingCurveKey ?? '';
  if (!pool) return false;
  try {
    void new PublicKey(pool);
    return true;
  } catch {
    return false;
  }
}

function isPossibleHoneyPot(evt: NewTokenEvent): boolean {
  const name = (evt.name ?? '').toLowerCase();
  const symbol = (evt.symbol ?? '').toLowerCase();
  const uri = (evt.uri ?? '').toLowerCase();

  const blacklistWords = [
    'scam',
    'rug',
    'honeypot',
    'phish',
    'fraud',
    'hack',
    'exploit',
  ];

  const text = `${name} ${symbol} ${uri}`;
  return blacklistWords.some((w) => text.includes(w));
}

function canSnipeMoreTokens(): boolean {
  if (!MAX_TOKENS_PER_HOUR || MAX_TOKENS_PER_HOUR <= 0) return true;

  const now = Date.now();
  if (lastHourTimestamp === 0) {
    lastHourTimestamp = now;
    tokensThisHour = 0;
    return true;
  }

  const diffMs = now - lastHourTimestamp;
  if (diffMs > 60 * 60 * 1000) {
    lastHourTimestamp = now;
    tokensThisHour = 0;
    return true;
  }

  return tokensThisHour < MAX_TOKENS_PER_HOUR;
}

function registerSnipedToken(): void {
  const now = Date.now();
  if (lastHourTimestamp === 0) {
    lastHourTimestamp = now;
    tokensThisHour = 0;
  }

  const diffMs = now - lastHourTimestamp;
  if (diffMs > 60 * 60 * 1000) {
    lastHourTimestamp = now;
    tokensThisHour = 0;
  }

  tokensThisHour++;
}

// --- Core: manejar un nuevo token ---

async function handleNewToken(evt: NewTokenEvent): Promise<void> {
  if (!SNIPE_NEW_TOKENS) return;

  const mint = evt.mint;
  if (!mint) return;

  if (!isLikelyPumpFunPool(evt)) {
    return;
  }

  if (isPossibleHoneyPot(evt)) {
    console.log(
      `⚠️ SNIPER IGNORE (honeypot heuristics): ${evt.name ?? ''} | ${mint}`,
    );
    return;
  }

  const ageSeconds = getTokenAgeSeconds(evt);
  if (ageSeconds > TOKEN_AGE_LIMIT_SECONDS) {
    console.log(
      `⏱️ SNIPER IGNORE (age ${ageSeconds.toFixed(
        1,
      )}s > ${TOKEN_AGE_LIMIT_SECONDS}s): ${mint}`,
    );
    return;
  }

  const volumeSol = getInitialVolumeSol(evt);
  if (volumeSol < MIN_BUY_VOLUME_SOL) {
    console.log(
      `💧 SNIPER IGNORE (vol ${volumeSol.toFixed(
        4,
      )} SOL < ${MIN_BUY_VOLUME_SOL}): ${mint}`,
    );
    return;
  }

  if (!canSnipeMoreTokens()) {
    console.log(
      `🚦 SNIPER LIMIT REACHED (${MAX_TOKENS_PER_HOUR}/h), skipping: ${mint}`,
    );
    return;
  }

  console.log(
    `🔥 NEW TOKEN DETECTED: ${evt.name ?? ''} (${evt.symbol ?? ''}) | ${mint}`,
  );
  console.log(
    `   Age: ${ageSeconds.toFixed(1)}s, InitVol: ${volumeSol.toFixed(
      4,
    )} SOL, Pool: ${evt.pool ?? (evt as any).bondingCurveKey ?? 'N/A'}`,
  );

  const DRY_RUN = isDryRunEnabled();
  const positionSizeSol = POSITION_SIZE_SOL;

  if (!redis) {
    console.log('⚠️ SNIPER: Redis not initialized, cannot proceed');
    return;
  }

  registerSnipedToken();

  // --- DRY RUN: solo simulación, sin on-chain ---
  if (DRY_RUN) {
    const positionManager = new PositionManager(redis);
    const entryPriceData: PriceData = await priceService.getPrice(
      mint,
      true,
    );

    const entryPrice = entryPriceData.price ?? 0;
    const fakeTokensAmount =
      entryPrice > 0 ? positionSizeSol / entryPrice : 0;

    // ✅ Convertir entryPrice a string
    await positionManager.openPosition(
      mint,
      entryPrice.toString(),
      positionSizeSol,
      fakeTokensAmount,
      'sniper',
      {
        executedDex: 'Pump.fun',
        originalSignature: evt.signature ?? '',
        walletName: 'SNIPER',
        symbol: evt.symbol ?? '',
      },
    );

    console.log(
      `🧪 SNIPER DRY-RUN BUY: ${positionSizeSol} SOL on ${mint} @ ${entryPrice.toFixed(
        9,
      )}`,
    );

    await sendTelegramAlert(
      process.env.TELEGRAM_OWNER_CHAT_ID,
      `🧪 SNIPER DRY-RUN BUY\n\n` +
        `Token: ${evt.name ?? ''} (${evt.symbol ?? ''})\n` +
        `Mint: ${mint}\n` +
        `Age: ${ageSeconds.toFixed(1)}s\n` +
        `InitVol: ${volumeSol.toFixed(4)} SOL\n` +
        `Amount: ${positionSizeSol} SOL\n` +
        `Mode: DRY-RUN (NO TX SENT)`,
      false,
    );

    return;
  }

  // --- LIVE: ejecutar compra real vía MultiDexExecutor ---
  try {
    const executor = new MultiDexExecutor(
      process.env.PRIVATE_KEY as string,
      process.env.RPC_URL as string,
      false,
    );

    const buyResult = await executor.buyToken(
      mint,
      positionSizeSol,
      'Pump.fun',
    );

    if (!buyResult.success) {
      console.log(
        `❌ SNIPER BUY FAILED for ${mint}: ${buyResult.error ?? 'unknown'}`,
      );
      return;
    }

    const positionManager = new PositionManager(redis);
    const entryPrice = buyResult.effectivePrice ?? 0;
    const tokensAmount = buyResult.tokensAmount ?? 0;

    // ✅ Convertir entryPrice a string
    await positionManager.openPosition(
      mint,
      entryPrice.toString(),
      positionSizeSol,
      tokensAmount,
      'sniper',
      {
        executedDex: buyResult.executedDex ?? 'Pump.fun',
        originalSignature: buyResult.signature ?? evt.signature ?? '',
        walletName: 'SNIPER',
        symbol: evt.symbol ?? '',
      },
    );

    console.log(
      `💸 SNIPER BUY EXECUTED: ${positionSizeSol} SOL on ${mint} @ ${entryPrice.toFixed(
        9,
      )}`,
    );

    await sendTelegramAlert(
      process.env.TELEGRAM_OWNER_CHAT_ID,
      `💸 SNIPER LIVE BUY\n\n` +
        `Token: ${evt.name ?? ''} (${evt.symbol ?? ''})\n` +
        `Mint: ${mint}\n` +
        `Age: ${ageSeconds.toFixed(1)}s\n` +
        `InitVol: ${volumeSol.toFixed(4)} SOL\n` +
        `Amount: ${positionSizeSol} SOL\n` +
        `Mode: LIVE`,
      false,
    );
  } catch (error: any) {
    console.log(
      `❌ SNIPER ERROR while buying ${mint}:`,
      error?.message ?? String(error),
    );
  }
}

// --- WebSocket PumpPortal ---

const PUMPPORTAL_WS_URL =
  process.env.PUMPPORTAL_WS_URL ??
  'wss://pumpportal.fun/api/data';

function createSniperWebSocket(): WebSocket {
  const socket = new WebSocket(PUMPPORTAL_WS_URL);

  socket.on('open', () => {
    console.log('✅ SNIPER WS connected to Pump.fun / PumpPortal');

    const msg = {
      method: 'subscribeNewToken',
      params: {},
    };

    socket.send(JSON.stringify(msg));
  });

  socket.on('message', async (data: WebSocket.Data) => {
    try {
      const text =
        typeof data === 'string' ? data : data.toString();
      const parsed = JSON.parse(text);

      const raw = parsed.token ?? parsed.data ?? parsed;
      const evt = normalizeNewTokenEvent(raw);

      if (!evt.mint) {
        return;
      }

      await handleNewToken(evt);
    } catch (error: any) {
      console.error(
        '⚠️ Error parsing SNIPER WS message:',
        error?.message ?? String(error),
      );
    }
  });

  socket.on('error', (err) => {
    console.error('⚠️ SNIPER WS error:', err);
  });

  socket.on('close', () => {
    console.log('⚠️ SNIPER WS closed, will attempt reconnect in 5s...');
    setTimeout(() => {
      ws = createSniperWebSocket();
    }, 5000);
  });

  return socket;
}

// --- Inicialización pública ---

export async function startSniperMode(): Promise<void> {
  if (!SNIPE_NEW_TOKENS) {
    console.log('📡 SNIPER MODE disabled via env (SNIPE_NEW_TOKENS=false)');
    return;
  }

  if (!process.env.REDIS_URL) {
    console.log('❌ SNIPER: REDIS_URL not set');
    return;
  }

  if (!redis) {
    redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });

    try {
      await redis.ping();
      console.log('✅ SNIPER Redis connected');
    } catch (error: any) {
      console.log(
        '❌ SNIPER: Redis ping failed:',
        error?.message ?? String(error),
      );
      return;
    }
  }

  const cfg: SniperConfig = {
    dryRun: isDryRunEnabled(),
    positionSizeSol: POSITION_SIZE_SOL,
    tokenAgeLimitSeconds: TOKEN_AGE_LIMIT_SECONDS,
    minBuyVolumeSol: MIN_BUY_VOLUME_SOL,
    maxTokensPerHour: MAX_TOKENS_PER_HOUR,
  };

  console.log('🚀 SNIPER MODE (ALL NEW TOKENS) INITIALIZED');
  console.log(
    `   Mode: ${cfg.dryRun ? '📄 DRY_RUN (NO RPC)' : '💰 LIVE'}`,
  );
  console.log(
    `   TOKEN_AGE_LIMIT_SECONDS = ${cfg.tokenAgeLimitSeconds}`,
  );
  console.log(`   MIN_BUY_VOLUME_SOL      = ${cfg.minBuyVolumeSol}`);
  console.log(`   MAX_TOKENS_PER_HOUR     = ${cfg.maxTokensPerHour}`);
  console.log(`   POSITION_SIZE_SOL       = ${cfg.positionSizeSol}`);

  ws = createSniperWebSocket();
}

console.log('📡 SNIPER module loaded. Call startSniperMode() from worker.');
