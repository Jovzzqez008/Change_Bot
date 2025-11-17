// environment.ts - Helpers y configuración de entorno centralizada
import dns from 'node:dns';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', 'paper']);
const FALSY_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);

function normalize(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

export function parseBooleanEnv(value?: string | null, defaultValue = false): boolean {
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

export function parseNumberEnv(value?: string | null, defaultValue = 0): number {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return defaultValue;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseIntegerEnv(value?: string | null, defaultValue = 0): number {
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
export const USE_WEBHOOKS = parseBooleanEnv(process.env.USE_WEBHOOKS, false);

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

export const GRADUATION_MIN_PROFIT_PERCENT = parseNumberEnv(
  process.env.GRADUATION_MIN_PROFIT,
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

export const COPY_MIN_WALLETS_TO_BUY = parseIntegerEnv(
  process.env.MIN_WALLETS_TO_BUY,
  1,
);

export const COPY_MIN_WALLETS_TO_SELL = parseIntegerEnv(
  process.env.MIN_WALLETS_TO_SELL,
  1,
);

export const COPY_PROFIT_TARGET_ENABLED = parseBooleanEnv(
  process.env.COPY_PROFIT_TARGET_ENABLED,
  true,
);

export const COPY_PROFIT_TARGET_PERCENT = parseNumberEnv(
  process.env.COPY_PROFIT_TARGET,
  25,
);

export const TRAILING_STOP_ENABLED = parseBooleanEnv(
  process.env.TRAILING_STOP_ENABLED,
  true,
);

export const TRAILING_STOP_PERCENT = parseNumberEnv(
  process.env.TRAILING_STOP,
  12,
);

export const COPY_STOP_LOSS_ENABLED = parseBooleanEnv(
  process.env.COPY_STOP_LOSS_ENABLED,
  true,
);

export const COPY_STOP_LOSS_PERCENT = parseNumberEnv(
  process.env.COPY_STOP_LOSS,
  15,
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

export const RPC_WEBSOCKET_URL = (() => {
  const raw = (process.env.RPC_WEBSOCKET_URL ?? '').trim();
  return raw.length > 0 ? raw : undefined;
})();

export const TELEGRAM_OWNER_CHAT_ID = (() => {
  const raw = (process.env.TELEGRAM_OWNER_CHAT_ID ?? '').trim();
  return raw.length > 0 ? raw : undefined;
})();

// 🌐 DNS (opcional Cloudflare)
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

// ─────────────────────────────────────────────────────
// 🚀 Config avanzada: sniper, volumen, ventas parciales
// ─────────────────────────────────────────────────────

// Máximo de posiciones simultáneas (para /status y riskManager)
export const MAX_POSITIONS = parseIntegerEnv(
  process.env.MAX_POSITIONS,
  2,
);

// Estrategia adaptativa tipo “bot de Reddit”
export const ADAPTIVE_STRATEGY_ENABLED = parseBooleanEnv(
  process.env.ADAPTIVE_STRATEGY,
  false,
);

// 🔫 SNIPER: entrar a todos los nuevos tokens de Pump.fun
export const SNIPE_NEW_TOKENS_ENABLED = parseBooleanEnv(
  process.env.SNIPE_NEW_TOKENS,
  false,
);

// Límite de tokens por hora (0 = sin límite duro, se usa solo para métricas)
export const MAX_TOKENS_PER_HOUR = parseIntegerEnv(
  process.env.MAX_TOKENS_PER_HOUR,
  0,
);

// Edad máxima del token para considerarlo “nuevo” (segundos)
export const TOKEN_AGE_LIMIT_SECONDS = parseIntegerEnv(
  process.env.TOKEN_AGE_LIMIT_SECONDS,
  180,
);

// Tiempo mínimo antes de empezar a aplicar salidas agresivas (segundos)
export const EARLY_EXIT_TIME_SEC = parseIntegerEnv(
  process.env.EARLY_EXIT_TIME_SEC,
  180,
);

// Volumen mínimo en SOL para entrar en modo sniper (0 = sin filtro)
export const MIN_BUY_VOLUME_SOL = parseNumberEnv(
  process.env.MIN_BUY_VOLUME_SOL,
  0,
);

// 📉 Exit por volumen seco
export const VOLUME_EXIT_ENABLED = parseBooleanEnv(
  process.env.VOLUME_EXIT_ENABLED,
  false,
);

// Ventana de lookback para comparar volúmenes (segundos)
export const VOLUME_EXIT_LOOKBACK_SECONDS = parseIntegerEnv(
  process.env.VOLUME_EXIT_LOOKBACK_SECONDS,
  60,
);

// Porcentaje de caída de volumen que dispara exit (ej. 70 = volumen actual < 30% del anterior)
export const VOLUME_EXIT_DROP_PERCENT = parseNumberEnv(
  process.env.VOLUME_EXIT_DROP_PERCENT,
  70,
);

// 💰 Ventas parciales escalonadas
export const PARTIAL_TAKE_PROFIT_ENABLED = parseBooleanEnv(
  process.env.PARTIAL_TAKE_PROFIT_ENABLED,
  false,
);

// Nivel 1: vender X% de la posición al llegar a Y% de PnL
export const PARTIAL_TP1_PERCENT = parseNumberEnv(
  process.env.PARTIAL_TP1_PERCENT,
  100, // +100% por defecto
);

export const PARTIAL_TP1_SIZE_PERCENT = parseNumberEnv(
  process.env.PARTIAL_TP1_SIZE_PERCENT,
  50, // vender 50% de la posición
);

// Nivel 2: vender otro tramo más arriba
export const PARTIAL_TP2_PERCENT = parseNumberEnv(
  process.env.PARTIAL_TP2_PERCENT,
  200, // +200% por defecto
);

export const PARTIAL_TP2_SIZE_PERCENT = parseNumberEnv(
  process.env.PARTIAL_TP2_SIZE_PERCENT,
  25, // vender 25% extra
);
