// server.ts - Copy Trading Bot API with ENV CLEANER (TypeScript)
import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import {
  isDryRunEnabled,
  POSITION_SIZE_SOL,
  COPY_MIN_WALLETS_TO_BUY,
  COPY_MIN_WALLETS_TO_SELL,
  COPY_STOP_LOSS_ENABLED,
  COPY_STOP_LOSS_PERCENT,
  ENABLE_AUTO_TRADING,
} from './environment.js';

// 🧹 CRITICAL: Clean environment variables FIRST
console.log('🚀 Starting Copy Trading Bot Server...\n');
const envCleaner: unknown = cleanAndValidateEnv();

import express, { Request, Response } from 'express';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

const app = express();
app.use(express.json());

let redis: RedisClient | null = null;

try {
  if (!process.env.REDIS_URL) {
    console.log('⚠️ REDIS_URL not set - Redis not available for server');
  } else {
    redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });
    console.log('✅ Redis connected for server\n');
  }
} catch (error: any) {
  console.log(
    '⚠️ Redis not available for server:',
    error?.message ?? String(error),
  );
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req: Request, res: Response) => {
  res.json({
    message: '💼 Copy Trading Bot API',
    mode: isDryRunEnabled() ? 'PAPER' : 'LIVE',
  });
});

// 📊 Status endpoint
app.get('/status', async (req: Request, res: Response) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const openPositions = await redis.scard('open_positions');
    const trackedWallets = await redis.scard('tracked_wallets');
    const pendingSignals = await redis.llen('copy_signals');
    const dryRun = isDryRunEnabled();

    // Get tracked wallets details
    const walletAddresses = await redis.smembers('tracked_wallets');
    const wallets: Array<{
      address: string;
      name?: string;
      enabled: boolean;
    }> = [];

    for (const address of walletAddresses) {
      const walletData = (await redis.hgetall(
        `wallet:${address}`,
      )) as Record<string, string>;
      if (walletData && Object.keys(walletData).length > 0) {
        wallets.push({
          address: address.slice(0, 16) + '...',
          name: walletData.name,
          enabled: walletData.enabled === 'true',
        });
      }
    }

    // Get positions details
    const positionMints = await redis.smembers('open_positions');
    const positions: Array<{
      mint: string;
      wallet: string;
      entryPrice: string;
      holdTime: string;
      upvotes: string;
    }> = [];

    for (const mint of positionMints) {
      const position = (await redis.hgetall(
        `position:${mint}`,
      )) as Record<string, string>;
      if (position && position.strategy === 'copy') {
        const entryPrice = parseFloat(position.entryPrice);
        const entryTime = parseInt(position.entryTime, 10);
        const holdTimeSeconds = ((Date.now() - entryTime) / 1000).toFixed(0);

        positions.push({
          mint: mint.slice(0, 16) + '...',
          wallet: position.walletName || 'Unknown',
          entryPrice: entryPrice.toFixed(10),
          holdTime: `${holdTimeSeconds}s`,
          upvotes: position.upvotes || '1',
        });
      }
    }

    res.json({
      mode: dryRun ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
      trackedWallets: {
        count: trackedWallets,
        list: wallets,
      },
      positions: {
        count: openPositions,
        max: process.env.MAX_POSITIONS || '2',
        list: positions,
      },
      signals: {
        pending: pendingSignals,
      },
      config: {
        minWalletsToBuy: COPY_MIN_WALLETS_TO_BUY.toString(),
        minWalletsToSell: COPY_MIN_WALLETS_TO_SELL.toString(),
        positionSize: `${POSITION_SIZE_SOL} SOL`,
        stopLoss: COPY_STOP_LOSS_ENABLED
          ? `-${COPY_STOP_LOSS_PERCENT}%`
          : 'Disabled',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

// 👁️ List tracked wallets
app.get('/wallets', async (req: Request, res: Response) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const walletAddresses = await redis.smembers('tracked_wallets');
    const wallets: Array<{
      address: string;
      name?: string;
      copyPercentage?: string;
      enabled: boolean;
      stats: {
        tradesDetected: number;
        tradesCopied: number;
      };
    }> = [];

    for (const address of walletAddresses) {
      const walletData = (await redis.hgetall(
        `wallet:${address}`,
      )) as Record<string, string>;
      const trades = await redis.lrange(`wallet_trades:${address}`, 0, -1);
      const copiedTrades = await redis.lrange(
        `copied_from:${address}`,
        0,
        -1,
      );

      if (walletData && Object.keys(walletData).length > 0) {
        wallets.push({
          address,
          name: walletData.name,
          copyPercentage: walletData.copyPercentage,
          enabled: walletData.enabled === 'true',
          stats: {
            tradesDetected: trades.length,
            tradesCopied: copiedTrades.length,
          },
        });
      }
    }

    res.json({
      count: wallets.length,
      wallets,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

// ➕ Add wallet to track
app.post('/wallets/add', async (req: Request, res: Response) => {
  try {
    const { address, name, copyPercentage = 100 } = req.body as {
      address?: string;
      name?: string;
      copyPercentage?: number;
    };

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const { getWalletTracker } = await import('./walletTracker.js');
    const tracker = getWalletTracker();

    if (!tracker) {
      return res
        .status(500)
        .json({ error: 'Wallet tracker not initialized' });
    }

    const result = await tracker.addWallet(address, {
      name: name || `Wallet-${address.slice(0, 8)}`,
      copyPercentage,
      minAmount: 0.05,
      maxAmount: POSITION_SIZE_SOL,
    });

    if (result) {
      res.json({
        success: true,
        message: 'Wallet added successfully',
        wallet: {
          address,
          name: name || `Wallet-${address.slice(0, 8)}`,
          copyPercentage,
        },
      });
    } else {
      res.status(500).json({ error: 'Failed to add wallet' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

// ➖ Remove wallet
app.post('/wallets/remove', async (req: Request, res: Response) => {
  try {
    const { address } = req.body as { address?: string };

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const { getWalletTracker } = await import('./walletTracker.js');
    const tracker = getWalletTracker();

    if (!tracker) {
      return res
        .status(500)
        .json({ error: 'Wallet tracker not initialized' });
    }

    const result = await tracker.removeWallet(address);

    if (result) {
      res.json({
        success: true,
        message: 'Wallet removed successfully',
      });
    } else {
      res.status(500).json({ error: 'Failed to remove wallet' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

// 📊 Today's stats
app.get('/stats', async (req: Request, res: Response) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const { RiskManager } = await import('./riskManager.js');
    const riskManager = new RiskManager(redis);
    const stats = await riskManager.getDailyStats();

    if (!stats) {
      return res.json({ message: 'No trades today yet' });
    }

    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

// 🧹 Cleanup endpoint
app.post('/cleanup', async (req: Request, res: Response) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    let cleaned = 0;

    // Limpiar open_positions
    const openPositions = await redis.smembers('open_positions');
    for (const mint of openPositions) {
      const position = (await redis.hgetall(
        `position:${mint}`,
      )) as Record<string, string>;
      if (
        !position ||
        Object.keys(position).length === 0 ||
        position.status === 'closed'
      ) {
        await redis.srem('open_positions', mint);
        cleaned++;
      }
    }

    res.json({
      success: true,
      cleaned,
      remaining: {
        openPositions: await redis.scard('open_positions'),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

// 🔍 Debug env endpoint (only show lengths/validation)
app.get('/debug/env', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res
      .status(403)
      .json({ error: 'Not available in production' });
  }

  res.json({
    privateKeyLength: process.env.PRIVATE_KEY?.length || 0,
    privateKeyValid: process.env.PRIVATE_KEY?.length === 88,
    rpcUrlValid:
      !!process.env.RPC_URL &&
      process.env.RPC_URL.startsWith('https://'),
    redisUrlValid: !!process.env.REDIS_URL,
    pumpProgramId: process.env.PUMP_PROGRAM_ID,
    priorityFee: process.env.PRIORITY_FEE_MICROLAMPORTS,
    positionSize: POSITION_SIZE_SOL.toString(),
    dryRun: isDryRunEnabled() ? 'true' : 'false',
    autoTrading: ENABLE_AUTO_TRADING ? 'true' : 'false',
  });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}\n`);
  initializeModules().catch((error) => {
    console.log(
      '❌ Module initialization failed:',
      error?.message ?? String(error),
    );
  });
});

async function initializeModules(): Promise<void> {
  try {
    console.log('🔧 Initializing modules...\n');

    // 1. Iniciar Wallet Tracker
    if (process.env.RPC_URL && process.env.PUMP_PROGRAM_ID) {
      try {
        const { initWalletTracker } = await import('./walletTracker.js');
        await initWalletTracker();
        console.log('✅ Wallet Tracker started\n');
      } catch (error: any) {
        console.log(
          '⚠️ Wallet Tracker failed:',
          error?.message ?? String(error),
        );
      }
    } else {
      console.log(
        '⚠️ RPC_URL or PUMP_PROGRAM_ID missing - Wallet Tracker skipped\n',
      );
    }

    // 2. Iniciar Telegram bot
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { initTelegram } = await import('./telegram.js');
        await initTelegram();
        console.log('✅ Telegram bot started\n');
      } catch (error: any) {
        console.log(
          '⚠️ Telegram bot failed:',
          error?.message ?? String(error),
        );
      }
    } else {
      console.log(
        '⚠️ TELEGRAM_BOT_TOKEN missing - Telegram skipped\n',
      );
    }

    console.log('🎯 Copy Trading Configuration:');
    console.log(`   Min wallets to BUY: ${COPY_MIN_WALLETS_TO_BUY}`);
    console.log(`   Min wallets to SELL: ${COPY_MIN_WALLETS_TO_SELL}`);
    console.log(`   Position Size: ${POSITION_SIZE_SOL} SOL`);
    console.log(`   Max Positions: ${process.env.MAX_POSITIONS || '2'}`);
    console.log(
      `   Stop Loss: ${
        COPY_STOP_LOSS_ENABLED
          ? `Enabled (-${COPY_STOP_LOSS_PERCENT}%)`
          : 'Disabled'
      }\n`,
    );

    const mode = isDryRunEnabled()
      ? '📄 PAPER TRADING'
      : '💰 LIVE TRADING';
    console.log(`🚀 Bot is ready in ${mode} mode\n`);
  } catch (error: any) {
    console.log(
      '❌ Module initialization failed:',
      error?.message ?? String(error),
    );
  }
}

process.on('unhandledRejection', (err: any) => {
  console.log('Unhandled rejection:', err?.message ?? String(err));
});
