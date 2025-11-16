// worker.ts - Copy Trading Worker with ENV CLEANER + Graduation Monitor
import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import { isDryRunEnabled, ENABLE_AUTO_TRADING } from './environment.js';

console.log('🚀 Starting Copy Trading Worker...\n');

// Limpia / normaliza variables de entorno
const envCleaner: unknown = cleanAndValidateEnv();

import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

let redisClient: RedisClient | null = null;

async function startWorker(): Promise<void> {
  // Verificar Redis
  if (!process.env.REDIS_URL) {
    console.log('❌ REDIS_URL is not defined in environment variables');
    return;
  }

  // Verificar RPC
  if (!process.env.RPC_URL) {
    console.log('❌ RPC_URL is not defined in environment variables');
    return;
  }

  // Verificar PRIVATE_KEY
  if (!process.env.PRIVATE_KEY) {
    console.log('❌ PRIVATE_KEY is not defined in environment variables');
    return;
  }

  console.log('🔧 Environment validated. Connecting to Redis...\n');

  let redis: RedisClient;
  try {
    redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });
    await redis.ping();
    console.log('✅ Redis connected for worker\n');
    redisClient = redis;
  } catch (error: any) {
    console.log(
      '❌ Redis connection failed:',
      error?.message ?? String(error),
    );
    return;
  }

  try {
    // Verificar configuración necesaria
    const requiredVars: string[] = ['RPC_URL', 'PUMP_PROGRAM_ID', 'PRIVATE_KEY'];
    const missingVars: string[] = requiredVars.filter((v) => !process.env[v]);

    if (missingVars.length > 0) {
      console.log(`❌ Missing required env vars: ${missingVars.join(', ')}`);
      return;
    }

    // Verificar modo
    const dryRun: boolean = isDryRunEnabled();
    const autoTrading: boolean = ENABLE_AUTO_TRADING;

    console.log('⚙️  Configuration:');
    console.log(`   Trading: ${autoTrading ? '✅ ENABLED' : '❌ DISABLED'}`);
    console.log(`   Mode: ${dryRun ? '📄 PAPER' : '💰 LIVE'}`);
    console.log(`   RPC: ${process.env.RPC_URL?.slice(0, 30)}...`);
    console.log(
      `   Program: ${process.env.PUMP_PROGRAM_ID?.slice(0, 10)}...\n`,
    );

    // --- Módulos principales ---

    // 1. Inicializar Wallet Tracker
    try {
      const { initWalletTracker } = await import('./walletTracker.js');
      await initWalletTracker();
      console.log('✅ Wallet Tracker initialized');
    } catch (e: any) {
      console.log(
        '⚠️ Wallet Tracker init failed:',
        e?.message ?? String(e),
      );
    }

    // 2. Inicializar Price Service (singleton)
    try {
      const { getPriceService } = await import('./priceService.js');
      getPriceService(); // inicializa singleton
      console.log('✅ Price Service initialized');
    } catch (e: any) {
      console.log(
        '⚠️ Price Service init failed:',
        e?.message ?? String(e),
      );
    }

    // 4. GraduationHandler: monitor automático de graduación
    try {
      const { GraduationHandler } = await import('./graduationHandler.js');
      const graduationHandler = new GraduationHandler();
      // Se asume que monitorOpenPositions arranca su propio loop interno
      void graduationHandler.monitorOpenPositions();
      console.log('✅ Graduation Handler monitor started');
    } catch (e: any) {
      console.log(
        '⚠️ Graduation Handler init failed:',
        e?.message ?? String(e),
      );
    }

    // 5. Copy Monitor (ejecutor principal de copy trading)
    try {
      await import('./copyMonitor.js');
      console.log('✅ Copy Monitor started');
    } catch (e: any) {
      console.log(
        '❌ Copy Monitor failed to start:',
        e?.message ?? String(e),
      );
    }

    // 6. Diagnósticos periódicos (si diagnostic.ts expone runDiagnostics)
    try {
      const { runDiagnostics } = await import('./diagnostic.js');
      // No esperamos; se lanza en background
      void runDiagnostics(redis);
      console.log('✅ Diagnostics scheduled');
    } catch (e: any) {
      console.log(
        '⚠️ Diagnostics init failed:',
        e?.message ?? String(e),
      );
    }

    // 7. Logging de estado básico
    setInterval(async () => {
      if (!redis) return;

      try {
        const [
          activeScalps,
          openPositions,
          pendingSignals,
          trackedWallets,
        ] = await Promise.all([
          redis.scard('active_scalps'),
          redis.scard('open_positions'),
          redis.llen('pending_signals'),
          redis.scard('tracked_wallets'),
        ]);

        console.log('\n📊 Worker Status:');
        console.log(`   Active Scalps: ${activeScalps}`);
        console.log(`   Tracked Wallets: ${trackedWallets}`);
        console.log(`   Open Positions: ${openPositions}`);
        console.log(`   Pending Signals: ${pendingSignals}`);

        // Obtener stats de hoy (usando TradingAnalytics si existe)
        try {
          const { TradingAnalytics } = await import('./analytics.js');
          const analytics = new TradingAnalytics(redis);
          const stats = await analytics.getOverallStats(1); // últimos 1 día

          console.log('   📈 Daily Stats (last 1 day):');
          console.log(
            `      Trades: ${stats.totalTrades}, WinRate: ${stats.winRate}, PnL: ${stats.totalPnL}`,
          );
        } catch (e: any) {
          if (process.env.WALLET_TRACKER_DEBUG === 'true') {
            console.log(
              '   [DEBUG] Error getting daily stats:',
              e?.message ?? String(e),
            );
          }
        }

        console.log('');
      } catch {
        // No queremos tumbar el worker por un error de log
      }
    }, 60_000);
  } catch (error: any) {
    console.error(
      '❌ Worker initialization error:',
      error?.message ?? String(error),
    );
  }
}

// Manejo de señales para cerrar Redis correctamente
process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received: shutting down worker...');

  if (redisClient) {
    try {
      await redisClient.quit();
      console.log('✅ Redis closed gracefully');
    } catch (e: any) {
      console.error('❌ Error closing Redis:', e?.message ?? String(e));
    }
  }

  process.exit(0);
});

startWorker().catch((error: any) => {
  console.error(
    '❌ Fatal error in worker:',
    error?.message ?? String(error),
  );
  process.exit(1);
});
