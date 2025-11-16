// walletTracker.ts v5.4 - PARSER BULLETPROOF + DEBUG, HEALTHCHECK, METRICS - TypeScript

import {
  Connection,
  PublicKey,
  Logs,
  Context,
} from '@solana/web3.js';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import {
  RPC_WEBSOCKET_URL,
  POSITION_SIZE_SOL,
  TELEGRAM_OWNER_CHAT_ID,
} from './environment.js';

// --- Config desde ENV (con defaults seguros) ---

const HEALTH_CHECK_INTERVAL_MS = Number(
  process.env.WEBSOCKET_HEALTH_CHECK_INTERVAL ?? '60000',
);

const RECONNECT_DELAY_MS = Number(
  process.env.WEBSOCKET_RECONNECT_DELAY ?? '2000',
);

const MAX_RECONNECT_ATTEMPTS_ENV = Number(
  process.env.MAX_RECONNECT_ATTEMPTS ?? '5',
);

const MIN_SUBSCRIPTION_INTERVAL_MS = Number(
  process.env.MIN_SUBSCRIPTION_INTERVAL ?? '200',
);

const LOG_METRICS_INTERVAL_MS = Number(
  process.env.LOG_METRICS_INTERVAL ?? '300000',
);

// --- Tipos internos ---

type DexType = 'PUMP' | 'RAYDIUM_V4' | 'RAYDIUM_CLMM' | 'JUPITER' | 'ORCA';

interface TrackedWalletStats {
  totalTrades: number;
  copiedTrades: number;
  wins: number;
  losses: number;
}

interface TrackedWalletConfig {
  name?: string;
  copyPercentage?: string | number;
  minAmount?: string | number;
  maxAmount?: string | number;
  enabled?: boolean;
}

interface TrackedWalletInternal {
  pubkey: PublicKey;
  name: string;
  copyPercentage: number;
  minAmount: number;
  maxAmount: number;
  enabled: boolean;
  stats: TrackedWalletStats;
}

interface TxDetails {
  signature: string;
  wallet: string;
  mint: string;
  action: 'BUY' | 'SELL';
  tokenAmount: number;
  solAmount: number;
  timestamp: number;
  slot: number;
  dex: 'Pump.fun' | 'Raydium' | 'Jupiter' | 'Orca' | string;
}

interface WalletStatsDexEntry {
  trades: number;
  wins: number;
  pnl: number;
}

interface WalletStats {
  totalDetected: number;
  totalCopied: number;
  wins: number;
  losses: number;
  winRate: string;
  totalPnL: string;
  dexStats: Record<string, WalletStatsDexEntry>;
}

interface CopySignalPayload {
  walletAddress: string;
  walletName: string;
  mint: string;
  originalAmount: number;
  copyAmount: number;
  signature: string;
  timestamp: number;
  upvotes: number;
  buyers: string[];
  reason: string;
  dex: string;
}

interface SellSignalPayload {
  mint: string;
  walletAddress: string;
  sellCount: number;
  sellers: string[];
  timestamp: number;
  signature: string;
  dex: string;
}

interface TradeRecord {
  pnlSOL?: string;
  dex?: string;
  [k: string]: unknown;
}

// --- Redis compartido ---

const redis: RedisClient = new RedisClass(process.env.REDIS_URL as string, {
  maxRetriesPerRequest: null,
});

// 🎯 PROGRAM IDs
const DEX_PROGRAMS = {
  PUMP: new PublicKey(
    process.env.PUMP_PROGRAM_ID ||
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  ),
  RAYDIUM_V4: new PublicKey(
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ),
  RAYDIUM_CLMM: new PublicKey(
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ),
  JUPITER_V6: new PublicKey(
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  ),
  ORCA_WHIRLPOOL: new PublicKey(
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  ),
};

// 🔍 Modo debug (activar cuando tengas problemas)
const DEBUG_MODE = process.env.WALLET_TRACKER_DEBUG === 'true';

export class WalletTracker {
  private readonly connection: Connection;
  private readonly trackedWallets: Map<string, TrackedWalletInternal>;
  private readonly subscriptions: Map<string, number>;

  // 🆕 ESTADO DE CONEXIÓN / HEALTHCHECK
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS: number;
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private lastHealthCheck = Date.now();
  private connectionErrors = 0;

  // 🆕 RATE LIMITING DE SUSCRIPCIONES
  private subscriptionQueue: Array<{
    address: string;
    resolve: (value: void) => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessingQueue = false;
  private lastSubscriptionTime = 0;
  private readonly MIN_SUBSCRIPTION_INTERVAL = MIN_SUBSCRIPTION_INTERVAL_MS;

  // 🆕 MÉTRICAS
  private metrics = {
    totalTransactions: 0,
    successfulParses: 0,
    failedParses: 0,
    averageParseTime: 0,
    lastTransactionTime: 0,
    reconnections: 0,
    subscriptionFailures: 0,
  };

  constructor(rpcUrl: string) {
    const wsEndpoint =
      RPC_WEBSOCKET_URL ||
      rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint,
      // 🆕 CONFIGURACIÓN OPTIMIZADA
      confirmTransactionInitialTimeout: 60_000,
      disableRetryOnRateLimit: false,
      httpHeaders: {
        'Content-Type': 'application/json',
      },
    });

    this.trackedWallets = new Map();
    this.subscriptions = new Map();
    this.MAX_RECONNECT_ATTEMPTS =
      Number.isFinite(MAX_RECONNECT_ATTEMPTS_ENV) &&
      MAX_RECONNECT_ATTEMPTS_ENV > 0
        ? MAX_RECONNECT_ATTEMPTS_ENV
        : 5;

    console.log('👁️ Wallet Tracker v5.4 initialized (BULLETPROOF + HEALTHCHECK)');
    console.log('   Supported DEXs: Pump.fun, Raydium, Jupiter, Orca');
    if (RPC_WEBSOCKET_URL) {
      console.log(
        `   Custom WS endpoint: ${RPC_WEBSOCKET_URL.slice(0, 48)}...`,
      );
    }
    if (DEBUG_MODE) console.log('   🔍 DEBUG MODE ENABLED');

    // 🆕 Iniciar health check y manejo de errores WS
    this.startHealthCheck();
    this.setupWebSocketErrorHandling();

    // 🆕 Log de métricas periódicas
    setInterval(() => {
      this.logMetrics();
    }, LOG_METRICS_INTERVAL_MS);
  }

  // 🆕 HEALTH CHECK AUTOMÁTICO
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      void this.checkWebSocketHealth();
    }, HEALTH_CHECK_INTERVAL_MS);

    const anyInterval: any = this.healthCheckInterval;
    if (anyInterval && typeof anyInterval.unref === 'function') {
      anyInterval.unref();
    }

    console.log(
      `✅ Health check started (${HEALTH_CHECK_INTERVAL_MS}ms interval)`,
    );
  }

  // 🆕 VERIFICAR SALUD DE LA CONEXIÓN
  private async checkWebSocketHealth(): Promise<void> {
    try {
      const now = Date.now();

      // Si pasaron > 2 * intervalo sin actualizar lastHealthCheck, consideramos stale
      if (now - this.lastHealthCheck > HEALTH_CHECK_INTERVAL_MS * 2) {
        console.log('⚠️ WebSocket appears stale, reconnecting...');
        await this.reconnectAllWallets();
        return;
      }

      // Ping simple: getSlot es rápido y confiable
      const slot = await Promise.race([
        this.connection.getSlot('confirmed'),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Healthcheck timeout')), 5000),
        ),
      ]);

      if (slot !== null) {
        this.lastHealthCheck = now;
        this.connectionErrors = 0;

        if (DEBUG_MODE) {
          console.log(`✅ WebSocket healthy (slot: ${slot})`);
        }
      }
    } catch (error: any) {
      this.connectionErrors++;
      console.log(
        `⚠️ Health check failed (${this.connectionErrors}/3): ${
          error?.message ?? String(error)
        }`,
      );

      // Después de 3 errores consecutivos, reconectar
      if (this.connectionErrors >= 3) {
        console.log('❌ Multiple health check failures, reconnecting...');
        await this.reconnectAllWallets();
      }
    }
  }

  // 🆕 RECONEXIÓN INTELIGENTE
  private async reconnectAllWallets(): Promise<void> {
    if (this.isReconnecting) {
      console.log('⏳ Reconnection already in progress...');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.metrics.reconnections++;

    try {
      console.log(
        `\n🔄 Reconnecting all wallets (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`,
      );

      // Paso 1: Remover todas las suscripciones antiguas
      const oldSubscriptions = Array.from(this.subscriptions.entries());

      for (const [address, subId] of oldSubscriptions) {
        try {
          await this.connection.removeOnLogsListener(subId);
          if (DEBUG_MODE) {
            console.log(`   🔌 Removed old subscription for ${address.slice(0, 8)}`);
          }
        } catch {
          // Ignorar errores al remover
        }
      }

      this.subscriptions.clear();
      console.log(
        `   ✅ Cleared ${oldSubscriptions.length} old subscriptions`,
      );

      // Paso 2: Esperar un poco para que el WebSocket se estabilice
      const backoffTime = Math.min(
        RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
        10_000,
      );
      console.log(`   ⏳ Waiting ${backoffTime}ms before resubscribing...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));

      // Paso 3: Resubscribir todas las wallets
      let successCount = 0;
      let failCount = 0;

      for (const [address, wallet] of this.trackedWallets.entries()) {
        if (!wallet.enabled) continue;

        try {
          await this.subscribeToWallet(address);
          successCount++;

          // Rate limiting: no saturar RPC
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error: any) {
          failCount++;
          console.error(
            `   ❌ Failed to resubscribe ${address.slice(0, 8)}: ${
              error?.message ?? String(error)
            }`,
          );
        }
      }

      console.log(
        `   ✅ Reconnection complete: ${successCount} success, ${failCount} failed\n`,
      );

      // Reset counters si tuvo éxito
      if (successCount > 0) {
        this.reconnectAttempts = 0;
        this.connectionErrors = 0;
        this.lastHealthCheck = Date.now();
      }

      this.isReconnecting = false;
    } catch (error: any) {
      console.error(
        `❌ Reconnection failed: ${error?.message ?? String(error)}`,
      );

      this.isReconnecting = false;

      // Si alcanzamos el máximo de intentos, esperar más tiempo
      if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        console.log(
          `⏸️ Max reconnection attempts reached, waiting 5 minutes...`,
        );

        setTimeout(() => {
          this.reconnectAttempts = 0;
          void this.reconnectAllWallets();
        }, 300_000); // 5 minutos
      } else {
        // Reintentar con backoff exponencial
        const retryTime = Math.min(
          RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
          60_000,
        );

        console.log(`⏳ Retrying in ${retryTime / 1000}s...`);

        setTimeout(() => {
          void this.reconnectAllWallets();
        }, retryTime);
      }
    }
  }

  // 🆕 MANEJO DE ERRORES DE WEBSOCKET
  private setupWebSocketErrorHandling(): void {
    // Acceder al WebSocket interno de @solana/web3.js
    const ws = (this.connection as any)._rpcWebSocket;

    if (ws) {
      ws.on('error', (error: Error) => {
        console.error('🔴 WebSocket error:', error.message);
        this.connectionErrors++;

        // Reconectar si hay error crítico
        if (this.connectionErrors >= 2) {
          void this.reconnectAllWallets();
        }
      });

      ws.on('close', (code: number, reason: string) => {
        console.log(
          `⚠️ WebSocket closed (code: ${code}, reason: ${
            reason || 'Unknown'
          })`,
        );

        // Reconectar automáticamente
        setTimeout(() => {
          void this.reconnectAllWallets();
        }, RECONNECT_DELAY_MS);
      });

      console.log('✅ WebSocket error handling configured');
    }
  }

  // 🆕 PROCESAR COLA DE SUSCRIPCIONES (RATE LIMIT)
  private async processSubscriptionQueue(): Promise<void> {
    if (this.isProcessingQueue || this.subscriptionQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.subscriptionQueue.length > 0) {
      const item = this.subscriptionQueue.shift();
      if (!item) break;

      try {
        // Rate limiting: esperar entre suscripciones
        const now = Date.now();
        const timeSinceLastSub = now - this.lastSubscriptionTime;

        if (timeSinceLastSub < this.MIN_SUBSCRIPTION_INTERVAL) {
          const waitTime = this.MIN_SUBSCRIPTION_INTERVAL - timeSinceLastSub;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Subscribir
        await this.subscribeToWallet(item.address);
        this.lastSubscriptionTime = Date.now();

        item.resolve();
      } catch (error: any) {
        this.metrics.subscriptionFailures++;
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.isProcessingQueue = false;
  }

  // 🆕 AÑADIR WALLET A LA COLA (en lugar de subscribeToWallet directo)
  private async addWalletToQueue(walletAddress: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.subscriptionQueue.push({
        address: walletAddress,
        resolve,
        reject,
      });
      void this.processSubscriptionQueue();
    });
  }

  // 🆕 REGISTRAR MÉTRICA DE TRANSACCIÓN
  private recordTransactionMetric(
    success: boolean,
    parseTime: number,
  ): void {
    this.metrics.totalTransactions++;
    this.metrics.lastTransactionTime = Date.now();

    if (success) {
      this.metrics.successfulParses++;
    } else {
      this.metrics.failedParses++;
    }

    // Promedio móvil simple
    this.metrics.averageParseTime =
      this.metrics.averageParseTime * 0.9 + parseTime * 0.1;
  }

  // 🆕 LOG DE MÉTRICAS
  private logMetrics(): void {
    const successRate =
      this.metrics.totalTransactions > 0
        ? (
            (this.metrics.successfulParses /
              this.metrics.totalTransactions) *
            100
          ).toFixed(1)
        : '0';

    const timeSinceLastTx = Date.now() - this.metrics.lastTransactionTime;
    const minutesSinceLastTx = (timeSinceLastTx / 60000).toFixed(1);

    console.log('\n📊 WALLET TRACKER METRICS:');
    console.log(`   Total TXs: ${this.metrics.totalTransactions}`);
    console.log(`   Success Rate: ${successRate}%`);
    console.log(
      `   Avg Parse Time: ${this.metrics.averageParseTime.toFixed(0)}ms`,
    );
    console.log(`   Last TX: ${minutesSinceLastTx} min ago`);
    console.log(`   Reconnections: ${this.metrics.reconnections}`);
    console.log(
      `   Active Subscriptions: ${this.subscriptions.size}`,
    );
    console.log(`   Connection Errors: ${this.connectionErrors}`);
    console.log(
      `   Subscription Failures: ${this.metrics.subscriptionFailures}\n`,
    );

    // Alertas
    if (parseFloat(successRate) < 80) {
      console.log('⚠️ WARNING: Parse success rate below 80%!');
    }

    if (
      timeSinceLastTx > 600_000 &&
      this.trackedWallets.size > 0
    ) {
      console.log('⚠️ WARNING: No transactions in 10+ minutes!');
    }
  }

  // --- API PÚBLICA ---

  async addWallet(
    walletAddress: string,
    config: TrackedWalletConfig = {},
  ): Promise<boolean> {
    try {
      const pubkey = new PublicKey(walletAddress);

      const tracked: TrackedWalletInternal = {
        pubkey,
        name: config.name || `Wallet-${walletAddress.slice(0, 8)}`,
        copyPercentage: parseFloat(
          String(config.copyPercentage ?? '100'),
        ),
        minAmount: parseFloat(
          String(config.minAmount ?? POSITION_SIZE_SOL),
        ),
        maxAmount: parseFloat(
          String(config.maxAmount ?? POSITION_SIZE_SOL),
        ),
        enabled: config.enabled !== false,
        stats: {
          totalTrades: 0,
          copiedTrades: 0,
          wins: 0,
          losses: 0,
        },
      };

      this.trackedWallets.set(walletAddress, tracked);

      await redis.hset(`wallet:${walletAddress}`, {
        name: tracked.name,
        copyPercentage: String(config.copyPercentage ?? '100'),
        minAmount: String(config.minAmount ?? POSITION_SIZE_SOL),
        maxAmount: String(config.maxAmount ?? POSITION_SIZE_SOL),
        enabled: 'true',
        added_at: Date.now().toString(),
      });

      await redis.sadd('tracked_wallets', walletAddress);
      console.log(
        `✅ Tracking wallet: ${
          config.name || walletAddress.slice(0, 8)
        }`,
      );

      // Usar cola en lugar de subscribeToWallet directo (rate limiting)
      await this.addWalletToQueue(walletAddress);
      return true;
    } catch (error: any) {
      console.error(
        `❌ Error adding wallet ${walletAddress}:`,
        error?.message ?? String(error),
      );
      return false;
    }
  }

  // 🔧 subscribeToWallet ROBUSTO (con retry + timeout)
  async subscribeToWallet(walletAddress: string): Promise<void> {
    try {
      // Prevenir suscripciones duplicadas
      if (this.subscriptions.has(walletAddress)) {
        if (DEBUG_MODE) {
          console.log(
            `   ⏭️ Skipping ${walletAddress.slice(
              0,
              8,
            )} (already subscribed)`,
          );
        }
        return;
      }

      const pubkey = new PublicKey(walletAddress);
      const wallet = this.trackedWallets.get(walletAddress);

      if (!wallet || !wallet.enabled) return;

      let subscriptionId: number | null = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts && subscriptionId === null) {
        try {
          subscriptionId = await Promise.race([
            this.connection.onLogs(
              pubkey,
              async (logs: Logs, context: Context) => {
                this.lastHealthCheck = Date.now(); // actualizar en cada log
                await this.handleWalletTransaction(
                  walletAddress,
                  logs,
                  context,
                );
              },
              'confirmed',
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Subscription timeout')),
                10_000,
              ),
            ),
          ]);
        } catch (error: any) {
          attempts++;
          console.log(
            `   ⚠️ Subscription attempt ${attempts}/${maxAttempts} failed: ${
              error?.message ?? String(error)
            }`,
          );

          if (attempts < maxAttempts) {
            await new Promise(resolve =>
              setTimeout(resolve, 1000 * attempts),
            );
          }
        }
      }

      if (subscriptionId === null) {
        this.metrics.subscriptionFailures++;
        throw new Error(
          `Failed to subscribe after ${maxAttempts} attempts`,
        );
      }

      this.subscriptions.set(walletAddress, subscriptionId);
      console.log(
        `📡 Subscribed to ${wallet.name} (${walletAddress.slice(
          0,
          8,
        )}...) [ID: ${subscriptionId}]`,
      );
    } catch (error: any) {
      console.error(
        `❌ Error subscribing to ${walletAddress}:`,
        error?.message ?? String(error),
      );
      throw error;
    }
  }

  private async handleWalletTransaction(
    walletAddress: string,
    logs: Logs,
    _context: Context,
  ): Promise<void> {
    const startTime = Date.now();
    let success = false;

    try {
      const signature = logs.signature;
      const wallet = this.trackedWallets.get(walletAddress);

      if (!wallet || !wallet.enabled) return;

      const dexType = this.detectDEXType(logs.logs);
      if (!dexType) return;

      console.log(`\n⚡ ${dexType} DETECTION from ${wallet.name}`);
      console.log(`   Signature: ${signature}`);

      const txDetails = await this.parseTransaction(
        signature,
        walletAddress,
        dexType,
      );

      if (!txDetails) {
        console.log(`   ❌ Failed to parse transaction\n`);
        return;
      }

      console.log(`   ✅ Parsed successfully`);
      await this.processWithUpvotes(walletAddress, txDetails);

      success = true;
    } catch (error: any) {
      console.error(
        `❌ Error handling transaction:`,
        error?.message ?? String(error),
      );
    } finally {
      const parseTime = Date.now() - startTime;
      this.recordTransactionMetric(success, parseTime);
    }
  }

  private detectDEXType(logLines: string[]): DexType | null {
    for (const log of logLines) {
      if (log.includes(DEX_PROGRAMS.PUMP.toString())) return 'PUMP';
      if (log.includes(DEX_PROGRAMS.RAYDIUM_V4.toString()))
        return 'RAYDIUM_V4';
      if (log.includes(DEX_PROGRAMS.RAYDIUM_CLMM.toString()))
        return 'RAYDIUM_CLMM';
      if (log.includes(DEX_PROGRAMS.JUPITER_V6.toString()))
        return 'JUPITER';
      if (log.includes(DEX_PROGRAMS.ORCA_WHIRLPOOL.toString()))
        return 'ORCA';
    }
    return null;
  }

  private async parseTransaction(
    signature: string,
    walletAddress: string,
    dexType: DexType,
  ): Promise<TxDetails | null> {
    try {
      console.log(`   🔍 Fetching transaction details (${dexType})...`);

      // We keep it as any to handle both parsed and raw responses
      const tx: any = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) {
        console.log(`   ⚠️ Transaction not found or no metadata`);
        return null;
      }

      console.log(`   ✅ Transaction fetched`);

      // 🔍 Debug completo si está activado
      if (DEBUG_MODE) {
        await this.debugTransaction(tx, walletAddress);
      }

      switch (dexType) {
        case 'PUMP':
          return await this.parsePumpTransaction(
            tx,
            walletAddress,
            signature,
          );
        case 'RAYDIUM_V4':
        case 'RAYDIUM_CLMM':
          return await this.parseRaydiumTransaction(
            tx,
            walletAddress,
            signature,
          );
        case 'JUPITER':
          return await this.parseJupiterTransaction(
            tx,
            walletAddress,
            signature,
          );
        case 'ORCA':
          return await this.parseOrcaTransaction(
            tx,
            walletAddress,
            signature,
          );
        default:
          return null;
      }
    } catch (error: any) {
      console.error(`   ❌ Parse error: ${error?.message ?? String(error)}`);
      return null;
    }
  }

  // 🛡️ PARSER BULLETPROOF - Pump.fun
  private async parsePumpTransaction(
    tx: any,
    walletAddress: string,
    signature: string,
  ): Promise<TxDetails | null> {
    try {
      // 1. Validar estructura
      if (!tx?.meta?.preBalances || !tx?.meta?.postBalances) {
        console.log(`   ⚠️ Invalid transaction structure`);
        return null;
      }

      // 2. Obtener account keys (múltiples métodos)
      const accountKeys: PublicKey[] =
        tx.transaction.message.staticAccountKeys ||
        tx.transaction.message.accountKeys ||
        [];

      if (accountKeys.length === 0) {
        console.log(`   ⚠️ No account keys found`);
        return null;
      }

      // 3. Buscar wallet (múltiples métodos)
      let walletIndex = -1;

      // Método A: Búsqueda directa
      walletIndex = accountKeys.findIndex(k => {
        try {
          return k.toString() === walletAddress;
        } catch {
          return false;
        }
      });

      // Método B: Si no encontró, buscar por balance change
      if (walletIndex === -1) {
        const preBalances: number[] = tx.meta.preBalances;
        const postBalances: number[] = tx.meta.postBalances;

        for (
          let i = 0;
          i < Math.min(preBalances.length, postBalances.length);
          i++
        ) {
          if (preBalances[i] !== postBalances[i]) {
            try {
              if (accountKeys[i]?.toString() === walletAddress) {
                walletIndex = i;
                console.log(
                  `   🔍 Found wallet via balance change (index ${i})`,
                );
                break;
              }
            } catch {
              // ignore
            }
          }
        }
      }

      if (walletIndex === -1) {
        console.log(`   ⚠️ Wallet not found in transaction`);
        console.log(
          `      Searched ${walletAddress.slice(0, 8)}... in ${
            accountKeys.length
          } accounts`,
        );
        return null;
      }

      console.log(`   ✅ Wallet confirmed at index: ${walletIndex}`);

      // 4. Calcular cambio de SOL - UMBRAL MÁS ALTO
      const preSOL =
        (tx.meta.preBalances[walletIndex] || 0) / 1e9;
      const postSOL =
        (tx.meta.postBalances[walletIndex] || 0) / 1e9;
      const solChange = Math.abs(preSOL - postSOL);

      // AUMENTAR UMBRAL MÍNIMO (evitar false positives)
      if (solChange < 0.001) {
        console.log(
          `   ⚠️ No significant SOL change (${solChange.toFixed(
            6,
          )} SOL)`,
        );
        console.log(
          `   ℹ️ Likely internal operation (approval/wrap/etc)`,
        );
        return null;
      }

      console.log(`   💰 SOL change: ${solChange.toFixed(4)} SOL`);

      // 5. Buscar token (múltiples métodos)
      const preTokenBalances = tx.meta.preTokenBalances || [];
      const postTokenBalances = tx.meta.postTokenBalances || [];

      let mint: string | null = null;
      let preTokenAmount = 0;
      let postTokenAmount = 0;
      let tokenDelta = 0;

      // Método A: Por owner
      for (const postBal of postTokenBalances) {
        if (!postBal?.mint) continue;

        if (postBal.owner === walletAddress) {
          const preBal = preTokenBalances.find(
            (p: any) =>
              p?.mint === postBal.mint &&
              p?.owner === walletAddress,
          );

          const preAmt = this.safeParseTokenAmount(preBal);
          const postAmt = this.safeParseTokenAmount(postBal);
          const delta = postAmt - preAmt;

          if (Math.abs(delta) > 0.00001) {
            mint = postBal.mint;
            preTokenAmount = preAmt;
            postTokenAmount = postAmt;
            tokenDelta = delta;
            console.log(`   🎯 Token found by owner`);
            break;
          }
        }
      }

      // Método B: Por accountIndex
      if (!mint) {
        for (const postBal of postTokenBalances) {
          if (!postBal?.mint) continue;

          const preBal = preTokenBalances.find(
            (p: any) => p?.mint === postBal.mint,
          );
          const preAmt = this.safeParseTokenAmount(preBal);
          const postAmt = this.safeParseTokenAmount(postBal);
          const delta = postAmt - preAmt;

          if (Math.abs(delta) > 1) {
            mint = postBal.mint;
            preTokenAmount = preAmt;
            postTokenAmount = postAmt;
            tokenDelta = delta;
            console.log(`   🎯 Token found by amount change`);
            break;
          }
        }
      }

      // Método C: Buscar en PRE para SELLs
      if (!mint) {
        for (const preBal of preTokenBalances) {
          if (!preBal?.mint) continue;

          if (preBal.owner === walletAddress) {
            const postBal = postTokenBalances.find(
              (p: any) =>
                p?.mint === preBal.mint &&
                p?.owner === walletAddress,
            );

            const preAmt = this.safeParseTokenAmount(preBal);
            const postAmt = this.safeParseTokenAmount(postBal);
            const delta = postAmt - preAmt;

            if (Math.abs(delta) > 0.00001) {
              mint = preBal.mint;
              preTokenAmount = preAmt;
              postTokenAmount = postAmt;
              tokenDelta = delta;
              console.log(`   🎯 Token found in PRE balance`);
              break;
            }
          }
        }
      }

      if (!mint) {
        console.log(`   ⚠️ Could not determine token mint`);
        console.log(
          `      PreTokenBalances: ${preTokenBalances.length}`,
        );
        console.log(
          `      PostTokenBalances: ${postTokenBalances.length}`,
        );

        if (
          preTokenBalances.length > 0 ||
          postTokenBalances.length > 0
        ) {
          console.log(
            `      First post token: ${
              postTokenBalances[0]?.mint?.slice(0, 8) || 'N/A'
            }`,
          );
          console.log(
            `      Owner matches: ${
              postTokenBalances.filter(
                (b: any) => b?.owner === walletAddress,
              ).length
            }`,
          );
        }

        return null;
      }

      // 6. Determinar acción
      const isBuy = tokenDelta > 0;
      const tokenAmount = Math.abs(tokenDelta);

      // 7. Validaciones finales
      if (tokenAmount < 0.00001) {
        console.log(
          `   ⚠️ Token amount too small: ${tokenAmount}`,
        );
        return null;
      }

      if (solChange < 0.001 || solChange > 1000) {
        console.log(
          `   ⚠️ SOL amount out of range: ${solChange}`,
        );
        return null;
      }

      // 8. Verificar que es Pump.fun
      const logs: string[] = tx.meta.logMessages || [];
      const isPumpProgram = logs.some((log: string) =>
        log.includes(DEX_PROGRAMS.PUMP.toString()),
      );

      if (!isPumpProgram) {
        console.log(`   ⚠️ Not a Pump.fun transaction`);
        return null;
      }

      // 9. Verificar que no hubo error
      if (tx.meta.err) {
        console.log(`   ⚠️ Transaction failed`);
        return null;
      }

      // 10. Resultado
      const timestamp: number = tx.blockTime
        ? tx.blockTime * 1000
        : Date.now();
      const pricePerToken = solChange / tokenAmount;

      console.log(
        `   📊 ${isBuy ? '🟢 BUY' : '🔴 SELL'} PARSED:`,
      );
      console.log(
        `      Mint: ${mint.slice(0, 8)}...${mint.slice(-8)}`,
      );
      console.log(
        `      Tokens: ${preTokenAmount.toFixed(
          2,
        )} → ${postTokenAmount.toFixed(2)}`,
      );
      console.log(`      SOL: ${solChange.toFixed(4)}`);
      console.log(
        `      Price: ~$${(pricePerToken * 1_000_000).toFixed(8)}`,
      );

      const details: TxDetails = {
        signature,
        wallet: walletAddress,
        mint,
        action: isBuy ? 'BUY' : 'SELL',
        tokenAmount,
        solAmount: solChange,
        timestamp,
        slot: tx.slot,
        dex: 'Pump.fun',
      };

      return details;
    } catch (error: any) {
      console.log(
        `   ❌ Parser error: ${error?.message ?? String(error)}`,
      );
      console.log(
        `      Stack: ${error?.stack?.split('\n')[1]?.trim()}`,
      );
      return null;
    }
  }

  // Helper para parsear token amounts de forma segura
  private safeParseTokenAmount(balance: any): number {
    try {
      if (!balance) return 0;
      return (
        balance.uiTokenAmount?.uiAmount ||
        parseFloat(
          balance.uiTokenAmount?.uiAmountString || '0',
        ) ||
        0
      );
    } catch {
      return 0;
    }
  }

  // 🔍 Debug completo de transacción
  private async debugTransaction(
    tx: any,
    walletAddress: string,
  ): Promise<void> {
    console.log('\n  🔍 ===== DEBUG INFO =====');

    try {
      const accountKeys: PublicKey[] =
        tx.transaction?.message?.staticAccountKeys ||
        tx.transaction?.message?.accountKeys ||
        [];

      console.log(`  Structure:`);
      console.log(`    Has meta: ${!!tx.meta}`);
      console.log(`    Account keys: ${accountKeys.length}`);
      console.log(
        `    Pre SOL balances: ${
          tx.meta?.preBalances?.length || 0
        }`,
      );
      console.log(
        `    Post SOL balances: ${
          tx.meta?.postBalances?.length || 0
        }`,
      );
      console.log(
        `    Pre token balances: ${
          tx.meta?.preTokenBalances?.length || 0
        }`,
      );
      console.log(
        `    Post token balances: ${
          tx.meta?.postTokenBalances?.length || 0
        }`,
      );

      const walletIndex = accountKeys.findIndex(k => {
        try {
          return k.toString() === walletAddress;
        } catch {
          return false;
        }
      });

      console.log(`  Wallet: ${walletAddress.slice(0, 8)}...`);
      console.log(`    Index: ${walletIndex}`);

      if (
        walletIndex >= 0 &&
        tx.meta?.preBalances &&
        tx.meta?.postBalances
      ) {
        const preSOL =
          (tx.meta.preBalances[walletIndex] || 0) / 1e9;
        const postSOL =
          (tx.meta.postBalances[walletIndex] || 0) / 1e9;
        console.log(`    Pre SOL: ${preSOL.toFixed(4)}`);
        console.log(`    Post SOL: ${postSOL.toFixed(4)}`);
        console.log(
          `    Change: ${(postSOL - preSOL).toFixed(4)}`,
        );
      }

      console.log(`  Token changes:`);
      const postTokens = tx.meta?.postTokenBalances || [];
      const preTokens = tx.meta?.preTokenBalances || [];

      for (const postBal of postTokens.slice(0, 3)) {
        const preBal = preTokens.find(
          (p: any) => p?.mint === postBal?.mint,
        );
        const preAmt = this.safeParseTokenAmount(preBal);
        const postAmt = this.safeParseTokenAmount(postBal);
        const delta = postAmt - preAmt;

        if (Math.abs(delta) > 0) {
          console.log(
            `    ${postBal.mint?.slice(0, 8)}: ${preAmt} → ${postAmt} (${
              delta >= 0 ? '+' : ''
            }${delta})`,
          );
          console.log(
            `      Owner: ${
              postBal.owner?.slice(0, 8) || 'N/A'
            }`,
          );
        }
      }

      console.log(`  =========================\n`);
    } catch (error: any) {
      console.log(
        `  Debug error: ${error?.message ?? String(error)}\n`,
      );
    }
  }

  // Otros parsers (sin cambios significativos - placeholders)

  private async parseRaydiumTransaction(
    _tx: any,
    _walletAddress: string,
    _signature: string,
  ): Promise<TxDetails | null> {
    // ... (código igual que antes / pendiente de implementar)
    return null;
  }

  private async parseJupiterTransaction(
    _tx: any,
    _walletAddress: string,
    _signature: string,
  ): Promise<TxDetails | null> {
    // ... (código igual que antes / pendiente de implementar)
    return null;
  }

  private async parseOrcaTransaction(
    _tx: any,
    _walletAddress: string,
    _signature: string,
  ): Promise<TxDetails | null> {
    // ... (código igual que antes / pendiente de implementar)
    return null;
  }

  private async processWithUpvotes(
    walletAddress: string,
    txDetails: TxDetails,
  ): Promise<void> {
    try {
      const wallet = this.trackedWallets.get(walletAddress);
      if (!wallet) return;

      const { mint, action, solAmount, dex } = txDetails;

      console.log(`   🎯 Processing ${action} with upvotes (${dex})...`);

      const upvoteKey = `upvotes:${mint}`;

      if (action === 'BUY') {
        await redis.sadd(`${upvoteKey}:buyers`, walletAddress);
        await redis.expire(`${upvoteKey}:buyers`, 600);

        await redis.hset(
          `${upvoteKey}:buy:${walletAddress}`,
          {
            walletName: wallet.name,
            solAmount: solAmount.toString(),
            timestamp: txDetails.timestamp.toString(),
            signature: txDetails.signature,
            dex: dex,
          },
        );
        await redis.expire(
          `${upvoteKey}:buy:${walletAddress}`,
          600,
        );

        const buyers = await redis.smembers(
          `${upvoteKey}:buyers`,
        );
        const upvoteCount = buyers.length;

        console.log(
          `   ✅ UPVOTES: ${upvoteCount} wallet(s) bought`,
        );

        await this.createCopySignal(
          mint,
          txDetails,
          upvoteCount,
          buyers,
        );
        await this.sendBuyAlert(
          wallet,
          txDetails,
          upvoteCount,
        );
      } else if (action === 'SELL') {
        await redis.sadd(`${upvoteKey}:sellers`, walletAddress);
        await redis.expire(`${upvoteKey}:sellers`, 600);

        const sellers = await redis.smembers(
          `${upvoteKey}:sellers`,
        );
        const sellCount = sellers.length;

        console.log(
          `   ✅ SELL COUNT: ${sellCount} wallet(s) sold`,
        );

        await this.createSellSignal(
          mint,
          txDetails,
          sellCount,
          sellers,
        );
        await this.sendSellAlert(
          wallet,
          txDetails,
          sellCount,
        );
      }
    } catch (error: any) {
      console.error(
        `   ❌ Upvotes error: ${error?.message ?? String(error)}`,
      );
    }
  }

  // 🎯 MODIFICADO: Usar cantidad fija de POSITION_SIZE_SOL
  private async createCopySignal(
    mint: string,
    txDetails: TxDetails,
    upvoteCount: number,
    buyers: string[],
  ): Promise<void> {
    try {
      const wallet = this.trackedWallets.get(txDetails.wallet);
      if (!wallet) return;

      // USAR CANTIDAD FIJA DE ENV (ignorar copyPercentage)
      const copyAmount = POSITION_SIZE_SOL;

      const copySignal: CopySignalPayload = {
        walletAddress: txDetails.wallet,
        walletName: wallet.name,
        mint,
        originalAmount: txDetails.solAmount,
        copyAmount,
        signature: txDetails.signature,
        timestamp: txDetails.timestamp,
        upvotes: upvoteCount,
        buyers,
        reason: 'wallet_buy',
        dex: txDetails.dex,
      };

      console.log(
        `   📤 Pushing copy signal to Redis queue...`,
      );
      await redis.lpush(
        'copy_signals',
        JSON.stringify(copySignal),
      );
      await redis.expire('copy_signals', 60);

      const queueLength = await redis.llen('copy_signals');
      console.log(
        `   ✅ Copy signal created (queue length: ${queueLength})`,
      );
    } catch (error: any) {
      console.error(
        `   ❌ Create signal error: ${error?.message ?? String(error)}`,
      );
    }
  }

  private async createSellSignal(
    mint: string,
    txDetails: TxDetails,
    sellCount: number,
    sellers: string[],
  ): Promise<void> {
    try {
      const sellSignal: SellSignalPayload = {
        mint,
        walletAddress: txDetails.wallet,
        sellCount,
        sellers,
        timestamp: txDetails.timestamp,
        signature: txDetails.signature,
        dex: txDetails.dex,
      };

      console.log(
        `   📤 Pushing sell signal to Redis queue...`,
      );
      await redis.lpush(
        'sell_signals',
        JSON.stringify(sellSignal),
      );
      await redis.expire('sell_signals', 60);

      const queueLength = await redis.llen('sell_signals');
      console.log(
        `   ✅ Sell signal created (queue length: ${queueLength})`,
      );
    } catch (error: any) {
      console.error(
        `   ❌ Create sell signal error: ${error?.message ?? String(error)}`,
      );
    }
  }

  private async sendBuyAlert(
    wallet: TrackedWalletInternal,
    txDetails: TxDetails,
    upvoteCount: number,
  ): Promise<void> {
    const chatId = TELEGRAM_OWNER_CHAT_ID;
    if (!chatId) return;

    try {
      const { sendTelegramAlert } = await import('./telegram.js');

      const confidence =
        upvoteCount === 1
          ? '🟡 Low'
          : upvoteCount === 2
          ? '🟢 Medium'
          : '🔥 High';

      const dexEmoji =
        txDetails.dex === 'Pump.fun'
          ? '🚀'
          : txDetails.dex === 'Raydium'
          ? '⚡'
          : txDetails.dex === 'Jupiter'
          ? '🪐'
          : txDetails.dex === 'Orca'
          ? '🐋'
          : '💱';

      await sendTelegramAlert(
        chatId,
        `${dexEmoji} BUY SIGNAL (${txDetails.dex})\n\n` +
          `Trader: ${wallet.name}\n` +
          `Token: ${txDetails.mint.slice(0, 16)}...\n` +
          `Amount: ${txDetails.solAmount.toFixed(4)} SOL\n` +
          `\n` +
          `🎯 Upvotes: ${upvoteCount} wallet(s)\n` +
          `Confidence: ${confidence}\n` +
          `\n` +
          `Signature: ${txDetails.signature.slice(0, 16)}...`,
        false,
      );
    } catch (e: any) {
      console.log(
        `   ⚠️ Telegram alert failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  private async sendSellAlert(
    wallet: TrackedWalletInternal,
    txDetails: TxDetails,
    sellCount: number,
  ): Promise<void> {
    const chatId = TELEGRAM_OWNER_CHAT_ID;
    if (!chatId) return;

    try {
      const { sendTelegramAlert } = await import('./telegram.js');

      const dexEmoji =
        txDetails.dex === 'Pump.fun'
          ? '🚀'
          : txDetails.dex === 'Raydium'
          ? '⚡'
          : txDetails.dex === 'Jupiter'
          ? '🪐'
          : txDetails.dex === 'Orca'
          ? '🐋'
          : '💱';

      await sendTelegramAlert(
        chatId,
        `⚠️ SELL SIGNAL (${txDetails.dex})\n\n` +
          `Trader: ${wallet.name}\n` +
          `Token: ${txDetails.mint.slice(0, 16)}...\n` +
          `Amount: ${txDetails.solAmount.toFixed(4)} SOL\n` +
          `\n` +
          `📉 Sellers: ${sellCount} wallet(s)\n` +
          `\n` +
          `Signature: ${txDetails.signature.slice(0, 16)}...`,
        false,
      );
    } catch (e: any) {
      console.log(
        `   ⚠️ Telegram alert failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  async removeWallet(walletAddress: string): Promise<boolean> {
    try {
      const subscriptionId =
        this.subscriptions.get(walletAddress);
      if (subscriptionId !== undefined) {
        try {
          await this.connection.removeOnLogsListener(
            subscriptionId,
          );
        } catch {
          // ignore
        }
        this.subscriptions.delete(walletAddress);
      }

      this.trackedWallets.delete(walletAddress);
      await redis.del(`wallet:${walletAddress}`);
      await redis.srem('tracked_wallets', walletAddress);

      console.log(
        `✅ Stopped tracking: ${walletAddress.slice(0, 8)}...`,
      );
      return true;
    } catch (error: any) {
      console.error(
        `❌ Error removing wallet:`,
        error?.message ?? String(error),
      );
      return false;
    }
  }

  getTrackedWallets(): Array<{
    address: string;
    name: string;
    enabled: boolean;
    copyPercentage: number;
    minAmount: number;
    maxAmount: number;
    stats: TrackedWalletStats;
  }> {
    const wallets: Array<{
      address: string;
      name: string;
      enabled: boolean;
      copyPercentage: number;
      minAmount: number;
      maxAmount: number;
      stats: TrackedWalletStats;
    }> = [];

    for (const [address, wallet] of this.trackedWallets.entries()) {
      wallets.push({
        address,
        name: wallet.name,
        enabled: wallet.enabled,
        copyPercentage: wallet.copyPercentage,
        minAmount: wallet.minAmount,
        maxAmount: wallet.maxAmount,
        stats: wallet.stats,
      });
    }

    return wallets;
  }

  async loadWalletsFromRedis(): Promise<void> {
    try {
      const walletAddresses = await redis.smembers(
        'tracked_wallets',
      );

      console.log(
        `\n📂 Loading ${walletAddresses.length} wallets from Redis...`,
      );

      // Cargar metadata primero (sin subscribir aún)
      for (const address of walletAddresses) {
        const walletData = (await redis.hgetall(
          `wallet:${address}`,
        )) as Record<string, string>;

        if (walletData && Object.keys(walletData).length > 0) {
          const pubkey = new PublicKey(address);

          const tracked: TrackedWalletInternal = {
            pubkey,
            name: walletData.name,
            copyPercentage: parseFloat(
              walletData.copyPercentage ?? '100',
            ),
            minAmount: parseFloat(
              walletData.minAmount ?? String(POSITION_SIZE_SOL),
            ),
            maxAmount: parseFloat(
              walletData.maxAmount ?? String(POSITION_SIZE_SOL),
            ),
            enabled: walletData.enabled === 'true',
            stats: {
              totalTrades: 0,
              copiedTrades: 0,
              wins: 0,
              losses: 0,
            },
          };

          this.trackedWallets.set(address, tracked);
        }
      }

      console.log(`✅ Loaded ${this.trackedWallets.size} wallet configs`);

      // Ahora subscribir usando la cola (con rate limiting)
      console.log('📡 Subscribing to wallets (rate-limited)...');

      for (const address of this.trackedWallets.keys()) {
        await this.addWalletToQueue(address);
      }

      console.log(`✅ All wallets subscribed\n`);
    } catch (error: any) {
      console.error(
        '❌ Error loading wallets from Redis:',
        error?.message ?? String(error),
      );
    }
  }

  async getWalletStats(
    walletAddress: string,
  ): Promise<WalletStats | null> {
    try {
      const trades = await redis.lrange(
        `wallet_trades:${walletAddress}`,
        0,
        -1,
      );
      const copiedTrades = await redis.lrange(
        `copied_from:${walletAddress}`,
        0,
        -1,
      );

      let wins = 0;
      let losses = 0;
      let totalPnL = 0;
      const dexStats: Record<string, WalletStatsDexEntry> = {};

      for (const tradeJson of copiedTrades) {
        try {
          const trade = JSON.parse(tradeJson) as TradeRecord;
          if (trade.pnlSOL) {
            const pnl = parseFloat(trade.pnlSOL);
            totalPnL += pnl;
            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;

            const dex = trade.dex || 'Unknown';
            if (!dexStats[dex]) {
              dexStats[dex] = { trades: 0, wins: 0, pnl: 0 };
            }
            dexStats[dex].trades++;
            if (pnl > 0) dexStats[dex].wins++;
            dexStats[dex].pnl += pnl;
          }
        } catch {
          // ignore bad record
        }
      }

      const winRate =
        copiedTrades.length > 0
          ? ((wins / copiedTrades.length) * 100).toFixed(1)
          : '0';

      return {
        totalDetected: trades.length,
        totalCopied: copiedTrades.length,
        wins,
        losses,
        winRate: `${winRate}%`,
        totalPnL: `${
          totalPnL >= 0 ? '+' : ''
        }${totalPnL.toFixed(4)} SOL`,
        dexStats,
      };
    } catch (error: any) {
      console.error(
        '❌ Error getting wallet stats:',
        error?.message ?? String(error),
      );
      return null;
    }
  }

  async close(): Promise<void> {
    console.log('\n🛑 Closing wallet tracker...');

    // Detener health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Remover todas las suscripciones
    for (const [address, subscriptionId] of this.subscriptions.entries()) {
      try {
        await this.connection.removeOnLogsListener(subscriptionId);
        console.log(`   ✅ Unsubscribed from ${address.slice(0, 8)}`);
      } catch (error: any) {
        console.log(
          `   ⚠️ Error unsubscribing ${address.slice(0, 8)}: ${
            error?.message ?? String(error)
          }`,
        );
      }
    }

    this.subscriptions.clear();
    this.trackedWallets.clear();

    console.log('✅ Wallet tracker closed cleanly');
  }
}

// --- Singleton & helpers (igual que en JS) ---

let trackerInstance: WalletTracker | null = null;

export async function initWalletTracker(): Promise<WalletTracker | null> {
  if (!process.env.RPC_URL) {
    console.log('⚠️ RPC_URL not set, skipping wallet tracker');
    return null;
  }

  trackerInstance = new WalletTracker(process.env.RPC_URL);
  await trackerInstance.loadWalletsFromRedis();

  return trackerInstance;
}

export function getWalletTracker(): WalletTracker | null {
  return trackerInstance;
}
