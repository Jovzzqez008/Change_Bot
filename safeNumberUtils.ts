// safeNumberUtils.ts
// Utilidades numéricas seguras para evitar NaN / Infinity en todo el bot.

export function safeParseNumber(
  value: unknown,
  fallback = 0,
  label = 'value',
): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return fallback;
  }

  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
    return fallback;
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    return fallback;
  }

  // cualquier otro tipo → fallback
  return fallback;
}

/**
 * Convierte SOL → lamports de forma segura.
 * Lanza error si el valor es inválido (NaN, negativo, etc.).
 */
export function solToLamports(sol: number, label = 'amount'): bigint {
  const n = safeParseNumber(sol, NaN, label);

  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new Error(`Invalid ${label}: not a finite number (${sol})`);
  }
  if (n < 0) {
    throw new Error(`Invalid ${label}: negative (${sol})`);
  }

  const lamports = Math.round(n * 1e9);
  return BigInt(lamports);
}

/**
 * Convierte a BigInt de manera segura.
 */
export function safeToBigInt(value: unknown, fallback: bigint = 0n): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return fallback;
      return BigInt(Math.trunc(value));
    }
    if (typeof value === 'string') {
      if (!value.trim()) return fallback;
      const n = BigInt(value.trim());
      return n;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * División segura: si denom es 0 o inválido, devuelve fallback.
 */
export function safeDivide(
  numerator: number,
  denominator: number,
  fallback = 0,
): number {
  const num = safeParseNumber(numerator, NaN, 'numerator');
  const den = safeParseNumber(denominator, NaN, 'denominator');

  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return fallback;
  }
  const result = num / den;
  return Number.isFinite(result) ? result : fallback;
}

/**
 * Slippage seguro: clamp [0.0001, 0.5] si el valor es raro.
 */
export function validateSlippage(
  slippage: number,
  defaultValue = 0.15,
): number {
  const s = safeParseNumber(slippage, defaultValue, 'slippage');

  if (!Number.isFinite(s) || s <= 0) return defaultValue;
  if (s > 0.5) return 0.5;
  if (s < 0.0001) return 0.0001;
  return s;
}

/**
 * Valida que los datos de la bonding curve tengan sentido.
 * Ambas reservas deben ser > 0.
 */
export function validateBondingCurveData(
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
): boolean {
  return virtualSolReserves > 0n && virtualTokenReserves > 0n;
}
