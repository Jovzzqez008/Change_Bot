import dns from 'node:dns';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', 'paper']);
const FALSY_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);

function normalize(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

export function parseBooleanEnv(
  value?: string | null,
  defaultValue = false,
): boolean {
  const normalized = normalize(value);
  if (!normalized) {
    return defaultValue;
  }
  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSY_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

export function parseNumberEnv(
  value?: string | null,
  defaultValue = 0,
): number {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return defaultValue;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseIntegerEnv(
  value?: string | null,
  defaultValue = 0,
): number {
  const n = parseNumberEnv(value, defaultValue);
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

//
// EXPORTS
//

export const isDryRunEnabled = () =>
  parseBooleanEnv(process.env.DRY_RUN, true);

export const ENABLE_AUTO_TRADING = parseBooleanEnv(
  process.env.ENABLE_AUTO_TRADING,
  true,
);

export const AUTO_SELL_ON_GRADUATION = parseBooleanEnv(
  process.env.AUTO_SELL_ON_GRADUATION,
  false,
);

//
// COPY TRADING SETTINGS
//
export const COPY_MIN_WALLETS_TO_BUY = parseIntegerEnv(
  process.env.COPY_MIN_WALLETS_TO_BUY,
  1,
);

export const COPY_MIN_WALLETS_TO_SELL = parseIntegerEnv(
  process.env.COPY_MIN_WALLETS_TO_SELL,
  1,
);

export const COPY_BLOCK_REBUY_ENABLED = parseBooleanEnv(
  process.env.COPY_BLOCK_REBUY_ENABLED,
  false,
);

export const COPY_REBUY_COOLDOWN_SECONDS = parseIntegerEnv(
  process.env.COPY_REBUY_COOLDOWN_SECONDS,
  0,
);

export const COPY_SIGNAL_TTL_SECONDS = parseIntegerEnv(
  process.env.COPY_SIGNAL_TTL_SECONDS,
  600,
);

//
// POSITION SIZE / RISK
//
export const POSITION_SIZE_SOL = parseNumberEnv(
  process.env.POSITION_SIZE_SOL,
  0.05,
);

export const MAX_POSITIONS = parseIntegerEnv(
  process.env.MAX_POSITIONS,
  2,
);

//
// Profit targets & stops (copy strategy clásica)
//
export const COPY_PROFIT_TARGET_PERCENT = parseNumberEnv(
  process.env.COPY_PROFIT_TARGET_PERCENT,
  300,
);

export const COPY_STOP_LOSS_ENABLED = parseBooleanEnv(
  process.env.COPY_STOP_LOSS_ENABLED,
  true,
);

export const COPY_STOP_LOSS_PERCENT = parseNumberEnv(
  process.env.COPY_STOP_LOSS_PERCENT,
  13,
);

export const TRAILING_STOP_ENABLED = parseBooleanEnv(
  process.env.TRAILING_STOP_ENABLED,
  true,
);

export const TRAILING_STOP_PERCENT = parseNumberEnv(
  process.env.TRAILING_STOP_PERCENT,
  15,
);

// Volume-based exit (activity drying up)
export const VOLUME_EXIT_ENABLED = parseBooleanEnv(
  process.env.VOLUME_EXIT_ENABLED,
  false,
);
export const VOLUME_DROP_PERCENT = parseNumberEnv(
  process.env.VOLUME_DROP_PERCENT,
  70,
);
export const VOLUME_WINDOW_SECONDS = parseIntegerEnv(
  process.env.VOLUME_WINDOW_SECONDS,
  60,
);
export const VOLUME_MIN_HOLD_SECONDS = parseIntegerEnv(
  process.env.VOLUME_MIN_HOLD_SECONDS,
  60,
);

// Partial take-profits
export const PARTIAL_TP_ENABLED = parseBooleanEnv(
  process.env.PARTIAL_TP_ENABLED,
  false,
);
export const PARTIAL_TP1_PCT = parseNumberEnv(
  process.env.PARTIAL_TP1_PCT,
  100,
);
export const PARTIAL_TP1_SELL_PCT = parseNumberEnv(
  process.env.PARTIAL_TP1_SELL_PCT,
  25,
);
export const PARTIAL_TP2_PCT = parseNumberEnv(
  process.env.PARTIAL_TP2_PCT,
  200,
);
export const PARTIAL_TP2_SELL_PCT = parseNumberEnv(
  process.env.PARTIAL_TP2_SELL_PCT,
  25,
);
export const PARTIAL_TP3_PCT = parseNumberEnv(
  process.env.PARTIAL_TP3_PCT,
  400,
);
export const PARTIAL_TP3_SELL_PCT = parseNumberEnv(
  process.env.PARTIAL_TP3_SELL_PCT,
  50,
);

// Max hold time (cierre duro por tiempo)
export const COPY_MAX_HOLD_ENABLED = parseBooleanEnv(
  process.env.COPY_MAX_HOLD_ENABLED,
  true,
);
export const COPY_MAX_HOLD_SECONDS = parseIntegerEnv(
  process.env.COPY_MAX_HOLD_SECONDS,
  3600,
);

//
// SIMULATION & STATS
//
export const DAILY_STATS_ENABLED = parseBooleanEnv(
  process.env.DAILY_STATS_ENABLED,
  true,
);

//
// TELEGRAM
//
export const TELEGRAM_LIVE_UPDATES_ENABLED = parseBooleanEnv(
  process.env.TELEGRAM_LIVE_UPDATES_ENABLED,
  true,
);

export const TELEGRAM_OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID ?? '';

//
// SNIPE NEW TOKENS / PUMP.FUN
//
export const SNIPE_NEW_TOKENS = parseBooleanEnv(
  process.env.SNIPE_NEW_TOKENS,
  false,
);

export const TOKEN_AGE_LIMIT_SECONDS = parseIntegerEnv(
  process.env.TOKEN_AGE_LIMIT_SECONDS,
  300,
);

export const MIN_BUY_VOLUME_SOL = parseNumberEnv(
  process.env.MIN_BUY_VOLUME_SOL,
  0.2,
);

export const MAX_TOKENS_PER_HOUR = parseIntegerEnv(
  process.env.MAX_TOKENS_PER_HOUR,
  30,
);

//
// PUMP.FUN / JUPITER / RPC
//
export const RPC_URL = process.env.RPC_URL ?? '';

export const PRIVATE_KEY = process.env.PRIVATE_KEY ?? '';

export const PUMP_FUN_SLIPPAGE_BPS = parseIntegerEnv(
  process.env.PUMP_FUN_SLIPPAGE_BPS,
  500,
);

export const JUPITER_SLIPPAGE_BPS = parseIntegerEnv(
  process.env.JUPITER_SLIPPAGE_BPS,
  1000,
);

export const PRIORITY_FEE_MICROLAMPORTS = parseIntegerEnv(
  process.env.PRIORITY_FEE_MICROLAMPORTS,
  500_000,
);

//
// REDIS
//
export const REDIS_URL =
  process.env.REDIS_URL ?? process.env.REDIS_TLS_URL ?? 'redis://localhost:6379';

//
// MODE / MISC
//
export const MODE = (process.env.MODE ?? 'PAPER').toUpperCase();

export const NODE_ENV = process.env.NODE_ENV ?? 'development';

export const DEBUG_LOGS_ENABLED = parseBooleanEnv(
  process.env.DEBUG_LOGS_ENABLED,
  false,
);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

//
// DNS tweak (Railway / Node 18+)
//
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

export const ENVIRONMENT_CONFIG = {
  mode: MODE,
  nodeEnv: NODE_ENV,
  dryRun: isDryRunEnabled(),
  autoTrading: ENABLE_AUTO_TRADING,
  copyTrading: {
    minWalletsBuy: COPY_MIN_WALLETS_TO_BUY,
    minWalletsSell: COPY_MIN_WALLETS_TO_SELL,
    positionSize: POSITION_SIZE_SOL,
    profitTargetPercent: COPY_PROFIT_TARGET_PERCENT,
    stopLossEnabled: COPY_STOP_LOSS_ENABLED,
    stopLossPercent: COPY_STOP_LOSS_PERCENT,
    trailingStopEnabled: TRAILING_STOP_ENABLED,
    trailingStopPercent: TRAILING_STOP_PERCENT,
    maxHoldEnabled: COPY_MAX_HOLD_ENABLED,
    maxHoldSeconds: COPY_MAX_HOLD_SECONDS,
  },
  volumeExit: {
    enabled: VOLUME_EXIT_ENABLED,
    dropPercent: VOLUME_DROP_PERCENT,
    windowSeconds: VOLUME_WINDOW_SECONDS,
    minHoldSeconds: VOLUME_MIN_HOLD_SECONDS,
  },
  partialTakeProfits: {
    enabled: PARTIAL_TP_ENABLED,
    levels: [
      { tp: PARTIAL_TP1_PCT, sellPct: PARTIAL_TP1_SELL_PCT },
      { tp: PARTIAL_TP2_PCT, sellPct: PARTIAL_TP2_SELL_PCT },
      { tp: PARTIAL_TP3_PCT, sellPct: PARTIAL_TP3_SELL_PCT },
    ],
  },
  snipeNewTokens: {
    enabled: SNIPE_NEW_TOKENS,
    tokenAgeLimitSeconds: TOKEN_AGE_LIMIT_SECONDS,
    minBuyVolumeSol: MIN_BUY_VOLUME_SOL,
    maxTokensPerHour: MAX_TOKENS_PER_HOUR,
  },
  rpc: {
    url: RPC_URL,
    priorityFeeMicrolamports: PRIORITY_FEE_MICROLAMPORTS,
  },
  dex: {
    pumpFunSlippageBps: PUMP_FUN_SLIPPAGE_BPS,
    jupiterSlippageBps: JUPITER_SLIPPAGE_BPS,
  },
  redis: {
    url: REDIS_URL,
  },
  telegram: {
    liveUpdates: TELEGRAM_LIVE_UPDATES_ENABLED,
    ownerChatId: TELEGRAM_OWNER_CHAT_ID,
    botToken: TELEGRAM_BOT_TOKEN,
  },
  debugLogs: DEBUG_LOGS_ENABLED,
};
