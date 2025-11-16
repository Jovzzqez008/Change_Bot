// utils.ts - Helpers finos conectados al nuevo PriceService
// Este archivo existe sobre todo por compatibilidad con módulos
// que hacen: import('./utils.js').then(({ getPriceFromBondingCurve }) => ...)

import {
  getPriceService,
  getPriceFromBondingCurve as coreGetPriceFromBondingCurve,
} from './priceService.js';

import type { CalculatedValue } from './priceService.js';

/**
 * Wrapper de compatibilidad.
 *
 * Antes, getPriceFromBondingCurve() devolvía solo:
 *   { virtualSolReserves, virtualTokenReserves }
 *
 * Ahora priceService devuelve:
 *   { virtualSolReserves, virtualTokenReserves, marketPrice, solValue, graduated, source }
 *
 * Este wrapper conserva compatibilidad con versiones viejas,
 * y provee propiedades estables para simuladores y CopyMonitor.
 */
export async function getPriceFromBondingCurve(
  mint: string,
  useVirtual = true,
): Promise<{
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  price?: number;
  solValue?: number;
  graduated: boolean;
  source: string;
} | null> {
  // Aseguramos inicialización del singleton
  getPriceService();

  const data: CalculatedValue | null = await coreGetPriceFromBondingCurve(
    mint,
    useVirtual,
  );

  if (!data) return null;

  return {
    virtualSolReserves: data.virtualSolReserves,
    virtualTokenReserves: data.virtualTokenReserves,
    price: data.marketPrice,
    solValue: data.solValue,
    graduated: data.graduated,
    source: data.source,
  };
}

/**
 * Helper: sleep / delay no bloqueante.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
