// diagnostic.ts - Herramienta para diagnosticar tokens atascados
import 'dotenv/config';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

let localRedis: RedisClient | null = null;

function getLocalRedis(): RedisClient {
  if (localRedis) return localRedis;

  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is not defined for diagnostics');
  }

  localRedis = new RedisClass(process.env.REDIS_URL as string, {
    maxRetriesPerRequest: null,
    // retryDelayOnFailover applies to cluster setups; omit for standalone Redis
  });

  return localRedis;
}

export async function runDiagnostics(
  redisOverride?: RedisClient,
): Promise<void> {
  const redis = redisOverride ?? getLocalRedis();
  console.log('\n🔍 ========== SYSTEM DIAGNOSTICS ==========\n');

  try {
    // 1. Verificar active_scalps
    const activeScalps = await redis.smembers('active_scalps');
    console.log(`📊 Active Scalps Set: ${activeScalps.length} tokens\n`);

    if (activeScalps.length === 0) {
      console.log('✅ No tokens in active_scalps (clean state)\n');
    } else {
      console.log('🔍 Analyzing each token:\n');

      for (const mint of activeScalps) {
        const key = `mint:${mint}`;
        const mintData = await redis.hgetall(key);

        console.log('───────────────────────────────────────');
        console.log(`Mint: ${mint.slice(0, 8)}...${mint.slice(-8)}`);

        if (!mintData || Object.keys(mintData).length === 0) {
          console.log('❌ NO DATA (orphaned entry)');
          console.log('   Action: Should be cleaned up');
        } else {
          console.log(`   Symbol: ${mintData.symbol || 'N/A'}`);
          console.log(`   Strategy: ${mintData.strategy || 'N/A'}`);
          console.log(`   Status: ${mintData.status || 'unknown'}`);

          if (mintData.created_at) {
            const age =
              (Date.now() - parseInt(mintData.created_at, 10)) / 1000;
            console.log(`   Age: ${age.toFixed(0)}s`);

            const maxAge = parseInt(
              process.env.MAX_ANALYSIS_SECONDS || '120',
              10,
            );
            if (age > maxAge && mintData.has_position !== 'true') {
              console.log(
                `   ⚠️ STALE (age ${age.toFixed(0)}s > max ${maxAge}s)`,
              );
              console.log('   Action: Should be removed');
            }
          }

          if (mintData.first_ts) {
            const timeSinceFirst =
              (Date.now() - parseInt(mintData.first_ts, 10)) / 1000;
            console.log(
              `   Time since first detection: ${timeSinceFirst.toFixed(0)}s`,
            );
          }
        }
      }

      console.log('\n✅ Analysis of active_scalps complete.\n');
    }

    // 2. Verificar open_positions
    const openPositions = await redis.smembers('open_positions');
    console.log(`📊 Open Positions Set: ${openPositions.length} tokens\n`);

    if (openPositions.length === 0) {
      console.log('✅ No tokens in open_positions (clean state)\n');
    } else {
      console.log('🔍 Analyzing open positions:\n');
      for (const mint of openPositions) {
        const posKey = `position:${mint}`;
        const posData = await redis.hgetall(posKey);

        console.log('───────────────────────────────────────');
        console.log(
          `Position Mint: ${mint.slice(0, 8)}...${mint.slice(-8)}`,
        );

        if (!posData || Object.keys(posData).length === 0) {
          console.log('❌ NO POSITION DATA');
          console.log(
            '   Action: Probably should be removed from open_positions',
          );
        } else {
          console.log(`   Strategy: ${posData.strategy || 'N/A'}`);
          console.log(`   Status: ${posData.status || 'unknown'}`);
          console.log(`   Entry Price: ${posData.entryPrice || 'N/A'}`);
          console.log(`   Last Price: ${posData.lastPrice || 'N/A'}`);
          console.log(`   PnL %: ${posData.pnlPercent || 'N/A'}`);
        }
      }

      console.log('\n✅ Analysis of open_positions complete.\n');
    }

    // 3. Verificar pending_signals
    const pendingSignalsLen = await redis.llen('pending_signals');
    console.log(`📊 Pending Signals: ${pendingSignalsLen}\n`);

    if (pendingSignalsLen === 0) {
      console.log('✅ No pending signals (clean state)\n');
    } else {
      console.log(
        '🔍 Analyzing pending signals (showing up to first 10):\n',
      );
      const signals = await redis.lrange('pending_signals', 0, 9);
      signals.forEach((signal, idx) => {
        console.log(`Signal #${idx + 1}: ${signal}`);
      });
      console.log(
        '\n⚠️ If there are too many pending signals, something may be stuck.\n',
      );
    }

    // 4. Verificar tracked_wallets
    const trackedWallets = await redis.smembers('tracked_wallets');
    console.log(`📊 Tracked Wallets: ${trackedWallets.length}\n`);

    if (trackedWallets.length === 0) {
      console.log('⚠️ No tracked wallets found. Is this expected?\n');
    } else {
      console.log('🔍 Listing tracked wallets (up to first 10):\n');
      trackedWallets.slice(0, 10).forEach((wallet, idx) => {
        console.log(`Wallet #${idx + 1}: ${wallet}`);
      });
      if (trackedWallets.length > 10) {
        console.log(
          `... and ${trackedWallets.length - 10} more wallets.`,
        );
      }
    }

    console.log('\n✅ Diagnostics completed successfully.\n');
  } catch (error) {
    console.error('❌ Error during diagnostics:', error);
  }
}
