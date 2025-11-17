// snipeNewTokens.ts - Modo SNIPER ALL NEW TOKENS (Pump.fun) con DRY_RUN friendly
import 'dotenv/config';
import WebSocket from 'ws';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

import {
  SNIPE_NEW_TOKENS,
  TOKEN_AGE_LIMIT_SECONDS,
  MIN_BUY_VOLUME_SOL,
  MAX_TOKENS_PER_HOUR,
  POSITION_SIZE_SOL,
  RPC_URL,
  ENABLE_AUTO_TRADING,
  TELEGRAM_OWNER_CHAT_ID,
  isDryRunEnabled,
} from './environment.js';

import { MultiDexExecutor } from './multiDexExecutor.js';
import { PositionManager } from './riskManager.js';
import { sendTelegramAlert } from './telegram.js';

// --- Tipos aproximados para eventos de nuevos tokens ---
// (La estructura real puede variar, estos campos son los más comunes)
interface NewTokenEvent {
  mint: string;
  symbol?: string;
  name?: string;
  creator: string;
  // timestamps en ms o segundos, lo normal es ms
  createdAt?: number; // ms
  launchTimestamp?: number; // ms o s
  // volumen / liquidez en SOL
  initialLiquiditySol?: number;
  volume1mSol?: number;
  marketCapSol?: number;
  priceSol?: number; // precio estimado en SOL por token
  [key: string]: any;
}

const DRY_RUN = isDryRunEnabled();

// WebSocket de Pump.fun / PumpPortal (puedes ajustar con ENV si quieres)
const PUMP_WS_URL =
  process.env.PUMP_WS_URL ||
  'wss://pumpportal.fun/api/data'; // valor por defecto, ajustable

// --- Instancias base ---

let redis: RedisClient | null = null;
let positionManager: PositionManager | null = null;
let tradeExecutor: MultiDexExecutor | null = null;
let ws: WebSocket | null = null;

// Control simple para no entrar a demasiados tokens por hora
let hourlySnipes = 0;

// --- Helpers numéricos / utilidades ---

function nowMs(): number {
  return Date.now();
}

function getTokenAgeSeconds(evt: NewTokenEvent): number {
  const now = nowMs();

  let createdMs: number | undefined;

  if (typeof evt.createdAt === 'number') {
    createdMs =
      evt.createdAt > 10_000_000_000 ? evt.createdAt : evt.createdAt * 1000;
  } else if (typeof evt.launchTimestamp === 'number') {
    createdMs =
      evt.launchTimestamp > 10_000_000_000
        ? evt.launchTimestamp
        : evt.launchTimestamp * 1000;
  }

  if (!createdMs) {
    // Si no viene timestamp, asumimos "recién creado"
    return 0;
  }

  return (now - createdMs) / 1000;
}

function getInitialVolumeSol(evt: NewTokenEvent): number {
  // Tomamos el volumen más informativo disponible
  return (
    evt.volume1mSol ??
    evt.initialLiquiditySol ??
    evt.marketCapSol ??
    0
  );
}

function getApproxPriceSol(evt: NewTokenEvent): number {
  // Si el evento trae un precio aproximado en SOL por token, lo usamos
  if (typeof evt.priceSol === 'number' && evt.priceSol > 0) {
    return evt.priceSol;
  }
  // Fallback ultra conservador para DRY_RUN
  return 0.00000001;
}

// --- Inicialización base (Redis + PositionManager + MultiDexExecutor) ---

async function ensureInitialized(): Promise<void> {
  if (!redis) {
    if (!process.env.REDIS_URL) {
      throw new Error('REDIS_URL is required for SNIPER mode');
    }
    redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });
  }

  if (!positionManager) {
    positionManager = new PositionManager(redis as RedisClient);
  }

  // Para DRY_RUN no creamos MultiDexExecutor para NO tocar el RPC
  if (!DRY_RUN && !tradeExecutor) {
    if (!process.env.PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY is required for LIVE SNIPER mode');
    }
    tradeExecutor = new MultiDexExecutor(
      process.env.PRIVATE_KEY as string,
      RPC_URL,
      DRY_RUN,
    );
  }
}

// --- Lógica principal de SNIPER ---

async function handleNewToken(evt: NewTokenEvent): Promise<void> {
  await ensureInitialized();

  const mint = evt.mint;
  if (!mint) return;

  const ageSec = getTokenAgeSeconds(evt);
  const volumeSol = getInitialVolumeSol(evt);

  // 1) Filtro por edad
  if (ageSec > TOKEN_AGE_LIMIT_SECONDS) {
    // Muy viejo para sniper
    return;
  }

  // 2) Filtro de volumen mínimo
  if (volumeSol < MIN_BUY_VOLUME_SOL) {
    return;
  }

  // 3) Límite por hora
  if (MAX_TOKENS_PER_HOUR > 0 && hourlySnipes >= MAX_TOKENS_PER_HOUR) {
    return;
  }

  // 4) ¿Ya tenemos posición abierta en este mint?
  if (redis) {
    const alreadyOpen = await redis.sismember('open_positions', mint);
    if (alreadyOpen) {
      return;
    }

    const cooldown = await redis.get(`sniper_cooldown:${mint}`);
    if (cooldown) {
      // Ya se intentó hace poco
      return;
    }
  }

  console.log('\n🎯 SNIPER SIGNAL - NEW TOKEN');
  console.log(`   Mint: ${mint}`);
  console.log(`   Age: ${ageSec.toFixed(1)}s`);
  console.log(`   Volume (approx): ${volumeSol.toFixed(4)} SOL`);

  await executeSniperBuy(evt);
}

async function executeSniperBuy(evt: NewTokenEvent): Promise<void> {
  if (!positionManager || !redis) return;

  const mint = evt.mint;
  const solAmount = POSITION_SIZE_SOL;

  // Marcador simple para no intentar de nuevo en unos segundos
  await redis.setex(`sniper_cooldown:${mint}`, 60, '1');

  const creator = evt.creator || 'unknown_creator';
  const tokenName =
    evt.name || evt.symbol || mint.slice(0, 8);

  if (DRY_RUN || !tradeExecutor || !ENABLE_AUTO_TRADING) {
    // ─────────────────────────────────────────
    // 📄 DRY_RUN: NO USAMOS RPC NI MultiDexExecutor
    // Simulamos la compra usando un precio aproximado
    // ─────────────────────────────────────────
    const approxPriceSol = getApproxPriceSol(evt);
    const tokensSimulated =
      approxPriceSol > 0
        ? solAmount / approxPriceSol
        : solAmount / 0.00000001;

    const entryPrice = approxPriceSol || 0.00000001;

    await positionManager.openPosition(
      mint,
      'SNIPER',
      entryPrice,
      solAmount,
      tokensSimulated,
      'SNIPER_DRY_RUN_BUY',
    );

    await redis.hset(`position:${mint}`, {
      strategy: 'sniper',
      walletSource: creator,
      walletName: 'SNIPER_DEV',
      originalSignature: 'SNIPER_NEW_TOKEN',
      originalDex: 'Pump.fun',
      executedDex: 'PAPER',
      exitStrategy: 'sniper_trailing',
      mode: 'DRY',
      entrySource: 'SNIPER',
      dex: 'Pump.fun',
      strategyTag: 'SNIPER',
    });

    hourlySnipes++;

    if (TELEGRAM_OWNER_CHAT_ID) {
      try {
        await sendTelegramAlert(
          TELEGRAM_OWNER_CHAT_ID,
          `🎯 SNIPER (DRY-RUN)\n\n` +
            `Token: ${tokenName}\n` +
            `Mint: ${mint.slice(0, 16)}...\n` +
            `Creator: ${creator.slice(0, 12)}...\n` +
            `Age: ${getTokenAgeSeconds(evt).toFixed(1)}s\n` +
            `Volume: ${getInitialVolumeSol(evt).toFixed(4)} SOL\n` +
            `\n` +
            `Simulated Buy: ${solAmount.toFixed(4)} SOL\n` +
            `Est. Price: ${entryPrice.toFixed(10)} SOL\n` +
            `Tokens (sim): ${tokensSimulated.toFixed(2)}\n` +
            `\n` +
            `Strategy: SNIPER_ALL_NEW_TOKENS\n` +
            `• DRY_RUN (no RPC used)\n` +
            `• TOKEN_AGE_LIMIT_SECONDS=${TOKEN_AGE_LIMIT_SECONDS}\n` +
            `• MIN_BUY_VOLUME_SOL=${MIN_BUY_VOLUME_SOL}\n` +
            `• MAX_TOKENS_PER_HOUR=${MAX_TOKENS_PER_HOUR}`,
          false,
        );
      } catch {
        /* ignore */
      }
    }

    console.log(
      `   ✅ DRY-RUN SNIPER POSITION OPENED for ${mint.slice(
        0,
        8,
      )}...`,
    );
    return;
  }

  // ─────────────────────────────────────────
  // 💰 LIVE MODE: usar MultiDexExecutor (Pump.fun + Jupiter)
  // ─────────────────────────────────────────
  try {
    console.log('   💰 Executing LIVE SNIPER BUY via MultiDexExecutor...');

    const buyResult = await tradeExecutor.buyToken(
      mint,
      solAmount,
      'auto',
    );

    if (!buyResult.success || !buyResult.tokensReceived) {
      console.log(
        `   ❌ SNIPER BUY FAILED: ${buyResult.error ?? 'Unknown error'}`,
      );
      return;
    }

    const entryPrice = getApproxPriceSol(evt);
    const tokensReceived = buyResult.tokensReceived;

    await positionManager.openPosition(
      mint,
      'SNIPER',
      entryPrice,
      solAmount,
      tokensReceived,
      buyResult.signature ?? 'SNIPER_BUY',
    );

    await redis.hset(`position:${mint}`, {
      strategy: 'sniper',
      walletSource: creator,
      walletName: 'SNIPER_DEV',
      originalSignature: 'SNIPER_NEW_TOKEN',
      originalDex: 'Pump.fun',
      executedDex: buyResult.dex ?? 'Unknown',
      exitStrategy: 'sniper_trailing',
      mode: 'LIVE',
      entrySource: 'SNIPER',
      dex: buyResult.dex ?? 'Pump.fun',
      strategyTag: 'SNIPER',
    });

    hourlySnipes++;

    if (TELEGRAM_OWNER_CHAT_ID) {
      try {
        const dexEmoji =
          buyResult.dex === 'Pump.fun'
            ? '🚀'
            : buyResult.dex === 'Jupiter'
            ? '🪐'
            : buyResult.dex === 'Raydium'
            ? '⚡'
            : buyResult.dex === 'Orca'
            ? '🐋'
            : '💱';

        await sendTelegramAlert(
          TELEGRAM_OWNER_CHAT_ID,
          `🎯 SNIPER BUY (LIVE)\n\n` +
            `Token: ${tokenName}\n` +
            `Mint: ${mint.slice(0, 16)}...\n` +
            `Creator: ${creator.slice(0, 12)}...\n` +
            `Age: ${getTokenAgeSeconds(evt).toFixed(1)}s\n` +
            `Volume: ${getInitialVolumeSol(evt).toFixed(4)} SOL\n` +
            `\n` +
            `${dexEmoji} DEX: ${buyResult.dex ?? 'Unknown'}\n` +
            `Amount: ${solAmount.toFixed(4)} SOL\n` +
            `Tokens: ${tokensReceived.toFixed(2)}\n` +
            `Signature: ${buyResult.signature?.slice(0, 16)}...\n` +
            `\n` +
            `Strategy: SNIPER_ALL_NEW_TOKENS\n` +
            `• TOKEN_AGE_LIMIT_SECONDS=${TOKEN_AGE_LIMIT_SECONDS}\n` +
            `• MIN_BUY_VOLUME_SOL=${MIN_BUY_VOLUME_SOL}\n` +
            `• MAX_TOKENS_PER_HOUR=${MAX_TOKENS_PER_HOUR}`,
          false,
        );
      } catch {
        /* ignore */
      }
    }

    console.log(
      `   ✅ LIVE SNIPER BUY EXECUTED on ${
        buyResult.dex ?? 'Unknown'
      }`,
    );
  } catch (error: any) {
    console.error(
      '   ❌ Error executing LIVE SNIPER BUY:',
      error?.message ?? String(error),
    );
  }
}

// --- WebSocket SNIPER LOOP ---

export async function startSniperMode(): Promise<void> {
  if (!SNIPE_NEW_TOKENS) {
    console.log('🔕 SNIPER mode disabled (SNIPE_NEW_TOKENS=false)');
    return;
  }

  if (!ENABLE_AUTO_TRADING) {
    console.log(
      '🔕 SNIPER mode disabled because ENABLE_AUTO_TRADING=false',
    );
    return;
  }

  await ensureInitialized();

  // Reset contador cada hora
  setInterval(() => {
    hourlySnipes = 0;
  }, 60 * 60 * 1000);

  console.log('🚀 SNIPER MODE (ALL NEW TOKENS) INITIALIZED');
  console.log(
    `   Mode: ${DRY_RUN ? '📄 DRY_RUN (NO RPC)' : '💰 LIVE (RPC + MultiDex)'}`,
  );
  console.log(`   TOKEN_AGE_LIMIT_SECONDS = ${TOKEN_AGE_LIMIT_SECONDS}`);
  console.log(`   MIN_BUY_VOLUME_SOL      = ${MIN_BUY_VOLUME_SOL}`);
  console.log(`   MAX_TOKENS_PER_HOUR     = ${MAX_TOKENS_PER_HOUR}`);
  console.log(`   POSITION_SIZE_SOL       = ${POSITION_SIZE_SOL}\n`);

  ws = new WebSocket(PUMP_WS_URL);

  ws.on('open', () => {
    console.log('✅ SNIPER WS connected to Pump.fun / PumpPortal');

    // NOTA: Este mensaje depende del protocolo real del WS.
    // Ajusta según la documentación real del endpoint que uses.
    const subMsg = {
      method: 'subscribeNewTokens',
      params: {},
    };
    try {
      ws?.send(JSON.stringify(subMsg));
    } catch {
      /* ignore */
    }
  });

  ws.on('message', async (data: WebSocket.RawData) => {
    try {
      const text =
        typeof data === 'string' ? data : data.toString('utf8');
      const parsed = JSON.parse(text);

      // Ajusta esta lógica según el formato real del WS
      const evt: NewTokenEvent =
        parsed.token ??
        parsed.data ??
        parsed as NewTokenEvent;

      if (!evt || !evt.mint) return;

      await handleNewToken(evt);
    } catch (error: any) {
      console.error(
        '⚠️ Error parsing SNIPER WS message:',
        error?.message ?? String(error),
      );
    }
  });

  ws.on('close', () => {
    console.log('⚠️ SNIPER WS connection closed');
  });

  ws.on('error', (error: any) => {
    console.error(
      '❌ SNIPER WS error:',
      error?.message ?? String(error),
    );
  });
}

console.log('📡 SNIPER module loaded. Call startSniperMode() from worker.');
