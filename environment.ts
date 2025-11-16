// environment.ts - FULL SYNC WITH .ENV (2025 Adaptive Strategy Edition)
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

//
// Helpers
//
const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "no", "n", "off"]);

function normalize(v?: string | null) {
  return (v ?? "").trim().toLowerCase();
}

export function parseBooleanEnv(v?: string | null, def = false): boolean {
  const n = normalize(v);
  if (!n) return def;
  if (TRUTHY.has(n)) return true;
  if (FALSY.has(n)) return false;
  return def;
}

export function parseNumberEnv(v?: string | null, def = 0): number {
  if (!v) return def;
  const parsed = Number(String(v).trim());
  return Number.isFinite(parsed) ? parsed : def;
}

export function parseIntegerEnv(v?: string | null, def = 0): number {
  if (!v) return def;
  const parsed = parseInt(v.trim(), 10);
  return Number.isFinite(parsed) ? parsed : def;
}

//
// EXPORTS
//

export const isDryRunEnabled = () =>
  parseBooleanEnv(process.env.DRY_RUN, true);

export const ENABLE_AUTO_TRADING = parseBooleanEnv(
  process.env.ENABLE_AUTO_TRADING,
  true
);

export const AUTO_SELL_ON_GRADUATION = parseBooleanEnv(
  process.env.AUTO_SELL_ON_GRADUATION,
  false
);

//
// COPY TRADING SETTINGS
//
export const COPY_MIN_WALLETS_TO_BUY = parseIntegerEnv(
  process.env.MIN_WALLETS_TO_BUY,
  1
);
export const COPY_MIN_WALLETS_TO_SELL = parseIntegerEnv(
  process.env.MIN_WALLETS_TO_SELL,
  1
);

export const COPY_PROFIT_TARGET_ENABLED = parseBooleanEnv(
  process.env.COPY_PROFIT_TARGET_ENABLED,
  true
);
export const COPY_PROFIT_TARGET_PERCENT = parseNumberEnv(
  process.env.COPY_PROFIT_TARGET,
  200
);

export const COPY_STOP_LOSS_ENABLED = parseBooleanEnv(
  process.env.COPY_STOP_LOSS_ENABLED,
  true
);
export const COPY_STOP_LOSS_PERCENT = parseNumberEnv(
  process.env.COPY_STOP_LOSS,
  15
);

export const TRAILING_STOP_ENABLED = parseBooleanEnv(
  process.env.TRAILING_STOP_ENABLED,
  true
);
export const TRAILING_STOP_PERCENT = parseNumberEnv(
  process.env.TRAILING_STOP,
  15
);

export const COPY_MAX_HOLD_ENABLED = parseBooleanEnv(
  process.env.COPY_MAX_HOLD_ENABLED,
  false
);
export const COPY_MAX_HOLD_SECONDS = parseIntegerEnv(
  process.env.COPY_MAX_HOLD_SECONDS,
  900
);

export const COPY_COOLDOWN_SECONDS = parseIntegerEnv(
  process.env.COPY_COOLDOWN,
  5
);

//
// POSITION SIZE
//
export const POSITION_SIZE_SOL = parseNumberEnv(
  process.env.POSITION_SIZE_SOL,
  0.05
);
export const ENTRY_SIZE_SOL = parseNumberEnv(
  process.env.ENTRY_SIZE_SOL,
  0.05
);

export const MAX_POSITIONS = parseIntegerEnv(
  process.env.MAX_POSITIONS,
  1
);

//
// SLIPPAGE
//
export const JUPITER_SLIPPAGE_PCT = parseNumberEnv(
  process.env.JUPITER_SLIPPAGE_PCT,
  0.03
);
export const PUMP_BUY_SLIPPAGE_PCT = parseNumberEnv(
  process.env.PUMP_BUY_SLIPPAGE_PCT,
  0.12
);
export const PUMP_SELL_SLIPPAGE_PCT = parseNumberEnv(
  process.env.PUMP_SELL_SLIPPAGE_PCT,
  0.10
);

//
// REBUY BLOCKING
//
export const BLOCK_REBUYS_ENABLED = parseBooleanEnv(
  process.env.BLOCK_REBUYS,
  true
);
export const REBUY_WINDOW_SECONDS = parseIntegerEnv(
  process.env.REBUY_WINDOW,
  900
);

//
// ADAPTIVE STRATEGY
//
export const ADAPTIVE_STRATEGY_ENABLED = parseBooleanEnv(
  process.env.ADAPTIVE_STRATEGY,
  false
);

//
// SNIPER MODE
//
export const SNIPE_NEW_TOKENS = parseBooleanEnv(
  process.env.SNIPE_NEW_TOKENS,
  false
);
export const MAX_TOKENS_PER_HOUR = parseIntegerEnv(
  process.env.MAX_TOKENS_PER_HOUR,
  0
);
export const TOKEN_AGE_LIMIT_SECONDS = parseIntegerEnv(
  process.env.TOKEN_AGE_LIMIT_SECONDS,
  180
);
export const EARLY_EXIT_TIME_SEC = parseIntegerEnv(
  process.env.EARLY_EXIT_TIME_SEC,
  180
);
export const MIN_BUY_VOLUME_SOL = parseNumberEnv(
  process.env.MIN_BUY_VOLUME_SOL,
  0
);

//
// RPC, WS
//
export const RPC_URL = process.env.RPC_URL || "";
export const RPC_WEBSOCKET_URL = process.env.RPC_WEBSOCKET_URL || "";

export const RPC_MAX_PER_SECOND = parseIntegerEnv(
  process.env.RPC_MAX_PER_SECOND,
  18
);
export const RPC_MAX_PER_MINUTE = parseIntegerEnv(
  process.env.RPC_MAX_PER_MINUTE,
  700
);

export const PUMP_PROGRAM_ID =
  process.env.PUMP_PROGRAM_ID ||
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const PRIORITY_FEE_MICROLAMPORTS = parseIntegerEnv(
  process.env.PRIORITY_FEE_MICROLAMPORTS,
  500000
);

//
// PRIVATE KEY / TELEGRAM
//
export const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_OWNER_CHAT_ID =
  process.env.TELEGRAM_OWNER_CHAT_ID || "";

export const TELEGRAM_LIVE_UPDATES = parseBooleanEnv(
  process.env.TELEGRAM_LIVE_UPDATES,
  true
);

//
// LOGGING
//
export const LOG_TO_FILE = parseBooleanEnv(
  process.env.LOG_TO_FILE,
  false
);
export const LOG_DIRECTORY = process.env.LOG_DIRECTORY || "./logs";

//
// DAILY REPORT
//
export const DAILY_REPORT_ENABLED = parseBooleanEnv(
  process.env.DAILY_REPORT_ENABLED,
  false
);
export const DAILY_REPORT_HOUR_MX = parseIntegerEnv(
  process.env.DAILY_REPORT_HOUR_MX,
  22
);

//
// CACHE
//
export const CACHE_HIGH_PRIORITY_MS = parseIntegerEnv(
  process.env.CACHE_HIGH_PRIORITY_MS,
  2000
);
export const CACHE_MEDIUM_PRIORITY_MS = parseIntegerEnv(
  process.env.CACHE_MEDIUM_PRIORITY_MS,
  5000
);
export const CACHE_LOW_PRIORITY_MS = parseIntegerEnv(
  process.env.CACHE_LOW_PRIORITY_MS,
  10000
);

//
// FINAL OBJECT FOR DEBUG
//
export const ENVIRONMENT_CONFIG = {
  dryRun: isDryRunEnabled(),
  autoSellOnGraduation: AUTO_SELL_ON_GRADUATION,
  adaptiveStrategy: ADAPTIVE_STRATEGY_ENABLED,
  sniper: SNIPE_NEW_TOKENS,
  maxPositions: MAX_POSITIONS,
  copy: {
    minBuy: COPY_MIN_WALLETS_TO_BUY,
    minSell: COPY_MIN_WALLETS_TO_SELL,
    tp: COPY_PROFIT_TARGET_PERCENT,
    sl: COPY_STOP_LOSS_PERCENT,
    trailing: TRAILING_STOP_PERCENT,
  },
};
