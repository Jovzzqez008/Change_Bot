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
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return defaultValue;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function isDryRunEnabled(): boolean {
  return parseBooleanEnv(process.env.DRY_RUN, false);
}

export const DRY_RUN_ENABLED = isDryRunEnabled();

export const FORCE_CLOUDFLARE_DNS = parseBooleanEnv(
  process.env.FORCE_CLOUDFLARE_DNS,
  false,
);

export const USE_WEBHOOKS = parseBooleanEnv(
  process.env.USE_WEBHOOKS,
  false,
);

export const JUPITER_SLIPPAGE_PCT = parseNumberEnv(
  process.env.JUPITER_SLIPPAGE_PCT,
  0.15,
);

export const PUMP_BUY_SLIPPAGE_PCT = parseNumberEnv(
  process.env.PUMP_BUY_SLIPPAGE_PCT,
  0.15,
);

export const PUMP_SELL_SLIPPAGE_PCT = parseNumberEnv(
  process.env.PUMP_SELL_SLIPPAGE_PCT,
  0.15,
);

// OJO: aquí usamos GRADUATION_MIN_PROFIT_PERCENT (como en envCleaner + GraduationHandler)
export const GRADUATION_MIN_PROFIT_PERCENT = parseNumberEnv(
  process.env.GRADUATION_MIN_PROFIT_PERCENT,
  0,
);

export const ENABLE_AUTO_TRADING = parseBooleanEnv(
  process.env.ENABLE_AUTO_TRADING,
  false,
);

export const TELEGRAM_LIVE_UPDATES_ENABLED = parseBooleanEnv(
  process.env.TELEGRAM_LIVE_UPDATES,
  true,
);

export const POSITION_SIZE_SOL = parseNumberEnv(
  process.env.POSITION_SIZE_SOL,
  0.1,
);

// Aquí ya usamos COPY_MIN_WALLETS_* (matching envCleaner + copyMonitor)
export const COPY_MIN_WALLETS_TO_BUY = parseIntegerEnv(
  process.env.COPY_MIN_WALLETS_TO_BUY,
  1,
);

export const COPY_MIN_WALLETS_TO_SELL = parseIntegerEnv(
  process.env.COPY_MIN_WALLETS_TO_SELL,
  1,
);

export const COPY_PROFIT_TARGET_ENABLED = parseBooleanEnv(
  process.env.COPY_PROFIT_TARGET_ENABLED,
  true,
);

// Matching envCleaner: COPY_PROFIT_TARGET_PERCENT
export const COPY_PROFIT_TARGET_PERCENT = parseNumberEnv(
  process.env.COPY_PROFIT_TARGET_PERCENT,
  30,
);

export const TRAILING_STOP_ENABLED = parseBooleanEnv(
  process.env.TRAILING_STOP_ENABLED,
  true,
);

// Matching envCleaner: TRAILING_STOP_PERCENT
export const TRAILING_STOP_PERCENT = parseNumberEnv(
  process.env.TRAILING_STOP_PERCENT,
  15,
);

export const COPY_STOP_LOSS_ENABLED = parseBooleanEnv(
  process.env.COPY_STOP_LOSS_ENABLED,
  true,
);

// Matching envCleaner: COPY_STOP_LOSS_PERCENT
export const COPY_STOP_LOSS_PERCENT = parseNumberEnv(
  process.env.COPY_STOP_LOSS_PERCENT,
  13,
);

export const COPY_MAX_HOLD_ENABLED = parseBooleanEnv(
  process.env.COPY_MAX_HOLD_ENABLED,
  false,
);

export const COPY_MAX_HOLD_SECONDS = parseIntegerEnv(
  process.env.COPY_MAX_HOLD,
  240,
);

export const COPY_COOLDOWN_SECONDS = parseIntegerEnv(
  process.env.COPY_COOLDOWN,
  60,
);

export const BLOCK_REBUYS_ENABLED = parseBooleanEnv(
  process.env.BLOCK_REBUYS,
  true,
);

export const REBUY_WINDOW_SECONDS = parseIntegerEnv(
  process.env.REBUY_WINDOW,
  300,
);

// Tamaño de entrada para el bot tipo "millón"
export const ENTRY_SIZE_SOL = parseNumberEnv(
  process.env.ENTRY_SIZE_SOL,
  POSITION_SIZE_SOL,
);

// Estrategia adaptativa (TP dinámico + trailing stops + tiempo)
export const ADAPTIVE_STRATEGY_ENABLED = parseBooleanEnv(
  process.env.ADAPTIVE_STRATEGY,
  true,
);

// Sniper de tokens nuevos en Pump.fun
export const SNIPE_NEW_TOKENS = parseBooleanEnv(
  process.env.SNIPE_NEW_TOKENS,
  true,
);

// Límite opcional de tokens por hora (0 = sin límite)
export const MAX_TOKENS_PER_HOUR = parseIntegerEnv(
  process.env.MAX_TOKENS_PER_HOUR,
  0,
);

// Parámetros de comportamiento temporal / volumen
export const TOKEN_AGE_LIMIT_SECONDS = parseIntegerEnv(
  process.env.TOKEN_AGE_LIMIT_SECONDS,
  180,
);

export const EARLY_EXIT_TIME_SEC = parseIntegerEnv(
  process.env.EARLY_EXIT_TIME_SEC,
  180,
);

export const MIN_BUY_VOLUME_SOL = parseNumberEnv(
  process.env.MIN_BUY_VOLUME_SOL,
  0,
);

// Logging a archivo local
export const LOG_TO_FILE = parseBooleanEnv(
  process.env.LOG_TO_FILE,
  true,
);

export const LOG_DIRECTORY = process.env.LOG_DIRECTORY ?? './logs';

// Reporte diario (hora México)
export const DAILY_REPORT_ENABLED = parseBooleanEnv(
  process.env.DAILY_REPORT_ENABLED,
  true,
);

export const DAILY_REPORT_HOUR_MX = parseIntegerEnv(
  process.env.DAILY_REPORT_HOUR_MX,
  22,
);

export const RPC_WEBSOCKET_URL = (() => {
  const raw = (process.env.RPC_WEBSOCKET_URL ?? '').trim();
  return raw.length > 0 ? raw : undefined;
})();

export const TELEGRAM_OWNER_CHAT_ID = (() => {
  const raw = (process.env.TELEGRAM_OWNER_CHAT_ID ?? '').trim();
  return raw.length > 0 ? raw : undefined;
})();

if (FORCE_CLOUDFLARE_DNS) {
  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first');
    }
    dns.setServers(['1.1.1.1', '1.0.0.1']);
    console.log('☁️ FORCE_CLOUDFLARE_DNS enabled - using Cloudflare resolvers');
  } catch (error: any) {
    console.log(
      '⚠️ Unable to apply FORCE_CLOUDFLARE_DNS setting:',
      error?.message ?? String(error),
    );
  }
}
