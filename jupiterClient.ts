// jupiterClient.ts - Wrapper del SDK oficial de Jupiter (Swap API v1)

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import fetch, { type RequestInit } from 'node-fetch';
import { safeParseNumber } from './safeNumberUtils.js';

const LITE_API_BASE = 'https://lite-api.jup.ag'; // host free plan
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface LiteApiClient {
  quoteGet(params: Record<string, unknown>): Promise<any>;
  swapPost(body: { swapRequest: Record<string, unknown> }): Promise<any>;
}

function createLiteApiClient(basePath: string): LiteApiClient {
  const normalizedBase = basePath.replace(/\/$/, '');

  async function request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${normalizedBase}${path}`;
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(
        `Jupiter Lite API error (${response.status} ${response.statusText}): ${text}`,
      );
    }
    return (await response.json()) as T;
  }

  return {
    async quoteGet(params: Record<string, unknown>) {
      const url = new URL(`${normalizedBase}/quote`);
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.append(key, String(value));
      }
      return request(url.toString());
    },
    async swapPost(body: { swapRequest: Record<string, unknown> }) {
      return request(`${normalizedBase}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

const jupiter = createLiteApiClient(`${LITE_API_BASE}/swap/v1`);

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint | number;
  slippage: number; // ej. 0.03 = 3%
}

export interface JupiterSwapResult {
  transaction: VersionedTransaction;
  // puedes extender esto si quieres más datos
}

/**
 * Obtiene una quote usando el SDK (@jup-ag/api).
 */
export async function getJupiterQuote(params: JupiterQuoteParams) {
  const { inputMint, outputMint } = params;

  const slippagePct = safeParseNumber(params.slippage, 0.03);
  const slippageBps = Math.floor(slippagePct * 10_000);

  const amountBigInt =
    typeof params.amount === 'bigint'
      ? params.amount
      : BigInt(Math.floor(params.amount));

  const quote = await jupiter.quoteGet({
    inputMint,
    outputMint,
    amount: amountBigInt.toString(),
    slippageBps,
    onlyDirectRoutes: false,
  });

  return quote;
}

/**
 * Construye la tx de swap lista para firmar y enviar.
 * Usa el response de quoteGet y la publicKey del usuario.
 */
export async function buildJupiterSwapTx(params: {
  quoteResponse: any;
  userPublicKey: PublicKey;
}) {
  const { quoteResponse, userPublicKey } = params;

  const swapRes = await jupiter.swapPost({
    swapRequest: {
      // El SDK espera los campos de la quote tal cual los devolvió quoteGet
      quoteResponse,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: undefined, // lo controlas tú con PRIORITY_FEE_MICROLAMPORTS
    },
  });

  const txBase64 = swapRes.swapTransaction;
  const txBuffer = Buffer.from(txBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);

  return {
    transaction: tx,
  } as JupiterSwapResult;
}

/**
 * Helper rápido para swap token -> SOL (cuando el token ya está graduado).
 */
export async function getQuoteTokenToSol(params: {
  mint: string;
  uiAmount: number;
  decimals: number;
  slippage: number;
}) {
  const { mint, uiAmount, decimals, slippage } = params;

  const safeUiAmount = safeParseNumber(uiAmount, NaN);
  if (!Number.isFinite(safeUiAmount) || safeUiAmount <= 0) {
    throw new Error('Invalid uiAmount');
  }

  const rawAmount = BigInt(Math.round(safeUiAmount * 10 ** decimals));

  return getJupiterQuote({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: rawAmount,
    slippage,
  });
}
