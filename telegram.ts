// telegram.ts - Telegram bot en TypeScript integrado con PriceService + MultiDexExecutor
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import type { Options as RequestOptions } from 'request';
import { getPriceService } from './priceService.js';
import type { PriceData } from './priceService.js';
import { isDryRunEnabled, POSITION_SIZE_SOL, MAX_POSITIONS } from './environment.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;

let bot: TelegramBot | null = null;
let redis: RedisClient | null = null;

const priceService = getPriceService();

// --- Helpers de tipos mínimos para evitar "any" descontrolado ---

interface RawPosition {
  mint: string;
  strategy?: string;
  entryPrice: string;
  solAmount: string;
  tokensAmount: string;
  entryTime: string;
  walletName?: string;
  upvotes?: string;
  executedDex?: string;
}

interface WalletInfo {
  name?: string;
  address: string;
  copyPercentage?: number;
  enabled?: boolean;
}

interface WalletStats {
  totalDetected: number;
  totalCopied: number;
  winRate?: string;
  totalPnL?: string;
}

// --- Helper: enviar mensaje seguro (sanear markdown) ---

async function safeSend(
  chatId: number | string | undefined,
  text: string,
  silent = false,
): Promise<boolean> {
  if (!bot || !chatId) return false;

  try {
    const cleanText = text
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .replace(/_/g, '')
      .replace(/\[/g, '')
      .replace(/\]/g, '');

    await bot.sendMessage(chatId, cleanText, {
      disable_notification: silent,
    });
    return true;
  } catch (error: any) {
    console.log('⚠️ Telegram send failed:', error?.message ?? String(error));
    return false;
  }
}

// --- Inicialización del bot ---

export async function initTelegram(): Promise<void> {
  if (!BOT_TOKEN) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN not set, skipping Telegram bot');
    return;
  }

  try {
    const requestOptions = {
      agentOptions: {
        keepAlive: true,
        family: 4,
      },
    } as RequestOptions;

    bot = new TelegramBot(BOT_TOKEN, {
      polling: true,
      request: requestOptions,
    });

    redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });

    console.log('✅ Telegram bot initialized');

    // === COMANDOS ===

    bot.onText(/\/start/, async msg => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return bot?.sendMessage(chatId, '⛔ Unauthorized');
      }

      await safeSend(
        chatId,
        '💼 Copy Trading Bot v3\n\n' +
          '📊 General:\n' +
          '/status - Current status\n' +
          '/positions - Open positions\n' +
          "/stats - Today's performance\n\n" +
          '👁️ Wallets:\n' +
          '/wallets - List tracked wallets\n' +
          '/add_wallet ADDRESS NAME - Add wallet\n' +
          '/remove_wallet ADDRESS - Remove wallet\n\n' +
          '💰 Trading:\n' +
          '/sell MINT - Manual sell\n' +
          '/sell_all - Close all positions',
      );
    });

    bot.onText(/\/status/, async msg => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      if (!redis) {
        await safeSend(chatId, '❌ Redis not initialized');
        return;
      }

      try {
        const openPositions = await redis.scard('open_positions');
        const trackedWallets = await redis.scard('tracked_wallets');
        const pendingSignals = await redis.llen('copy_signals');

        const mode = isDryRunEnabled() ? '📝 PAPER' : '💰 LIVE';

        let totalPnL = 0;
        const positionMints = await redis.smembers('open_positions');

        for (const mint of positionMints) {
          const position = (await redis.hgetall(
            `position:${mint}`,
          )) as unknown as RawPosition;

          if (position && position.strategy === 'copy') {
            const entryPrice = parseFloat(position.entryPrice);
            const solAmount = parseFloat(position.solAmount || '0');
            const priceData: PriceData = await priceService.getPrice(
              mint,
              true,
            );

            if (priceData && priceData.price !== null) {
              const pnlSol =
                ((priceData.price - entryPrice) / entryPrice) * solAmount;
              totalPnL += pnlSol;
            }
          }
        }

        await safeSend(
          chatId,
          '📊 Status\n\n' +
            `Mode: ${mode}\n` +
            `Tracked Wallets: ${trackedWallets}\n` +
            `Open Positions: ${openPositions}/${MAX_POSITIONS}\n` +
            `Pending Signals: ${pendingSignals}\n` +
            '\n' +
            `💰 Total P&L: ${totalPnL.toFixed(4)} SOL`,
        );
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /positions usando PriceService TS (getPrice con fallback interno)
    bot.onText(/\/positions/, async msg => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      if (!redis) {
        await safeSend(chatId, '❌ Redis not initialized');
        return;
      }

      try {
        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions: RawPosition[] =
          (await positionManager.getOpenPositions()) || [];

        const copyPositions = positions.filter(p => p.strategy === 'copy');

        if (copyPositions.length === 0) {
          return safeSend(chatId, '🔭 No open positions');
        }

        let message = '📈 Open Positions:\n\n';

        for (const pos of copyPositions) {
          const entryPrice = parseFloat(pos.entryPrice);

          // usamos PriceService.getPrice (delega a Pump.fun + Jupiter)
          const priceData = await priceService.getPrice(pos.mint, true);

          let currentPrice = entryPrice; // fallback
          let isGraduated = false;

          if (priceData && priceData.price !== null) {
            currentPrice = priceData.price;
            isGraduated =
              priceData.graduated ||
              priceData.source.toUpperCase().includes('JUPITER');
          } else {
            console.log(
              `   ⚠️ Using entry price as fallback for ${pos.mint.slice(
                0,
                8,
              )}`,
            );
          }

          const pnlPercent =
            ((currentPrice - entryPrice) / entryPrice) * 100;
          const pnlSOL =
            ((currentPrice - entryPrice) / entryPrice) *
            parseFloat(pos.solAmount || '0');
          const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
          const holdTime = (
            (Date.now() - parseInt(pos.entryTime, 10)) /
            1000
          ).toFixed(0);
          const upvotes = pos.upvotes || '1';

          const posNum = copyPositions.indexOf(pos) + 1;
          const graduatedTag = isGraduated ? ' 🎓' : '';

          message += `${emoji} Position ${posNum}${graduatedTag}\n`;
          message += `Wallet: ${pos.walletName || 'Unknown'}\n`;
          message += `Mint: ${pos.mint.slice(0, 12)}...\n`;
          message += `Entry: ${entryPrice.toFixed(8)}\n`;
          message += `Current: ${currentPrice.toFixed(8)}\n`;
          message += `PnL: ${pnlPercent.toFixed(2)}% | ${pnlSOL.toFixed(
            4,
          )} SOL\n`;
          message += `Hold: ${holdTime}s | Votes: ${upvotes}\n`;

          if (isGraduated) {
            message += 'Status: GRADUATED to DEX\n';
          }

          message += `/sell ${pos.mint.slice(0, 8)}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /sell MINT
    bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      const mintArg = match?.[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          '💰 Manual Sell\n\n' +
            'Usage: /sell MINT\n' +
            'Example: /sell 7xKXtGH4\n\n' +
            'Use /positions to see open positions',
        );
      }

      if (!redis) {
        await safeSend(chatId, '❌ Redis not initialized');
        return;
      }

      try {
        await safeSend(chatId, '⏳ Processing manual sell...');

        const positionMints = await redis.smembers('open_positions');
        let targetMint: string | null = null;

        for (const mint of positionMints) {
          if (mint.startsWith(mintArg) || mint.includes(mintArg)) {
            targetMint = mint;
            break;
          }
        }

        if (!targetMint) {
          return safeSend(chatId, `❌ No position found for: ${mintArg}`);
        }

        const position = (await redis.hgetall(
          `position:${targetMint}`,
        )) as unknown as RawPosition;

        if (!position || position.strategy !== 'copy') {
          return safeSend(chatId, '❌ Invalid position');
        }

        const priceData = await priceService.getPrice(targetMint, true);

        if (!priceData || priceData.price === null) {
          return safeSend(
            chatId,
            '❌ Could not get current price\n' +
              'Token may be graduated - try again in a moment',
          );
        }

        const currentPrice = priceData.price;
        const entryPrice = parseFloat(position.entryPrice);
        const pnlPercent =
          ((currentPrice - entryPrice) / entryPrice) * 100;
        const isGraduated =
          priceData.graduated ||
          priceData.source.toUpperCase().includes('JUPITER');

        // Seleccionar DEX correcto
        const { MultiDexExecutor } = await import('./multiDexExecutor.js');
        const { PositionManager } = await import('./riskManager.js');

        const dryRun = isDryRunEnabled();
        const tradeExecutor = new MultiDexExecutor(
          process.env.PRIVATE_KEY as string,
          process.env.RPC_URL as string,
          dryRun,
        );

        const dex = isGraduated ? 'Jupiter' : position.executedDex || 'auto';

        console.log(`\n💰 Manual sell: ${targetMint.slice(0, 8)}`);
        console.log(`   Graduated: ${isGraduated}`);
        console.log(`   DEX: ${dex}`);

        const tokensAmount = parseInt(position.tokensAmount, 10);
        const sellResult = await tradeExecutor.sellToken(
          targetMint,
          tokensAmount,
          dex as any,
        );

        if (sellResult.success) {
          const positionManager = new PositionManager(redis);
          const realizedSol =
            sellResult.solReceived ?? currentPrice * tokensAmount;
          const closedPosition = await positionManager.closePosition(
            targetMint,
            currentPrice,
            tokensAmount,
            realizedSol,
            'manual_sell',
            sellResult.signature,
          );

          const mode = dryRun ? '📝 PAPER' : '💰 LIVE';
          const graduatedTag = isGraduated ? ' 🎓' : '';
          const pnlSol = parseFloat(closedPosition.pnlSOL);

          await safeSend(
            chatId,
            `✅ ${mode} MANUAL SELL${graduatedTag}\n\n` +
              `Mint: ${targetMint.slice(0, 12)}...\n` +
              `${isGraduated ? `DEX: ${dex}\n` : ''}` +
              `Entry: ${entryPrice.toFixed(8)}\n` +
              `Exit: ${currentPrice.toFixed(8)}\n` +
              '\n' +
              `💰 PnL: ${pnlPercent.toFixed(2)}%\n` +
              `Amount: ${pnlSol.toFixed(4)} SOL\n` +
              '\n' +
              `Signature: ${sellResult.signature?.slice(0, 12)}...`,
          );
        } else {
          await safeSend(
            chatId,
            `❌ Sell failed: ${sellResult.error ?? 'Unknown error'}`,
          );
        }
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /sell_all
    bot.onText(/\/sell_all/, async msg => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      if (!redis) {
        await safeSend(chatId, '❌ Redis not initialized');
        return;
      }

      try {
        await safeSend(chatId, '⏳ Closing all positions...');

        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions: RawPosition[] =
          (await positionManager.getOpenPositions()) || [];

        const copyPositions = positions.filter(p => p.strategy === 'copy');

        if (copyPositions.length === 0) {
          return safeSend(chatId, '🔭 No positions to close');
        }

        let closed = 0;
        let failed = 0;

        for (const position of copyPositions) {
          try {
            const priceData = await priceService.getPrice(
              position.mint,
              true,
            );

            if (!priceData || priceData.price === null) {
              failed++;
              continue;
            }

            const isGraduated =
              priceData.graduated ||
              priceData.source.toUpperCase().includes('JUPITER');
            const dex = isGraduated
              ? 'Jupiter'
              : position.executedDex || 'auto';

            const { MultiDexExecutor } = await import(
              './multiDexExecutor.js'
            );
            const dryRun = isDryRunEnabled();
            const tradeExecutor = new MultiDexExecutor(
              process.env.PRIVATE_KEY as string,
              process.env.RPC_URL as string,
              dryRun,
            );

            const tokensAmount = parseInt(position.tokensAmount, 10);
            const sellResult = await tradeExecutor.sellToken(
              position.mint,
              tokensAmount,
              dex as any,
            );

            if (sellResult.success) {
              const realizedSol =
                sellResult.solReceived ?? priceData.price * tokensAmount;
              await positionManager.closePosition(
                position.mint,
                priceData.price,
                tokensAmount,
                realizedSol,
                'manual_sell_all',
                sellResult.signature,
              );
              closed++;
            } else {
              failed++;
            }
          } catch {
            failed++;
          }
        }

        await safeSend(
          chatId,
          '✅ Closed All Positions\n\n' +
            `Closed: ${closed}\n` +
            `Failed: ${failed}`,
        );
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /wallets
    bot.onText(/\/wallets/, async msg => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const { getWalletTracker } = await import('./walletTracker.js');
        const tracker: any = getWalletTracker();

        if (!tracker) {
          return safeSend(chatId, '⚠️ Wallet tracker not initialized');
        }

        const wallets: WalletInfo[] = tracker.getTrackedWallets();

        if (!wallets || wallets.length === 0) {
          return safeSend(
            chatId,
            '🔭 No wallets tracked\n\nUse /add_wallet to start',
          );
        }

        let message = '👁️ Tracked Wallets:\n\n';

        for (const wallet of wallets) {
          const stats: WalletStats = await tracker.getWalletStats(
            wallet.address,
          );

          message += `${wallet.name ?? 'Wallet'}\n`;
          message += `${wallet.address.slice(0, 12)}...\n`;
          message += `Copy: ${wallet.copyPercentage ?? 100}% | ${
            wallet.enabled ? 'Active' : 'Paused'
          }\n`;
          message += `Amount: ${POSITION_SIZE_SOL} SOL\n`;
          message += `Trades: ${stats.totalDetected} detected, ${stats.totalCopied} copied\n`;
          if (stats.totalCopied > 0) {
            message += `Win Rate: ${stats.winRate ?? 'N/A'} | P&L: ${
              stats.totalPnL ?? '0'
            }\n`;
          }
          message += `/remove_wallet ${wallet.address.slice(0, 12)}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /add_wallet ADDRESS NAME
    bot.onText(/\/add_wallet (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const parts = (match?.[1] ?? '').trim().split(/\s+/);
        const address = parts[0];
        const name = parts[1] || `Wallet-${address.slice(0, 8)}`;
        const copyPercentage = 100;

        const { getWalletTracker } = await import('./walletTracker.js');
        const tracker: any = getWalletTracker();

        if (!tracker) {
          return safeSend(chatId, '⚠️ Wallet tracker not initialized');
        }

        const result: boolean = await tracker.addWallet(address, {
          name,
          copyPercentage,
          minAmount: POSITION_SIZE_SOL,
          maxAmount: POSITION_SIZE_SOL,
        });

        if (result) {
          await safeSend(
            chatId,
            '✅ Wallet Added\n\n' +
              `Name: ${name}\n` +
              `Address: ${address.slice(0, 12)}...\n` +
              `Copy: ${copyPercentage}%\n` +
              `Amount: ${POSITION_SIZE_SOL} SOL\n\n` +
              'Now tracking trades',
          );
        } else {
          await safeSend(chatId, '❌ Failed to add wallet');
        }
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /remove_wallet
    bot.onText(/\/remove_wallet (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const addressArg = (match?.[1] ?? '').trim();

        const { getWalletTracker } = await import('./walletTracker.js');
        const tracker: any = getWalletTracker();

        if (!tracker) {
          return safeSend(chatId, '⚠️ Wallet tracker not initialized');
        }

        const wallets: WalletInfo[] = tracker.getTrackedWallets();
        let targetWallet: WalletInfo | null = null;

        for (const wallet of wallets) {
          if (
            wallet.address === addressArg ||
            wallet.address.startsWith(addressArg)
          ) {
            targetWallet = wallet;
            break;
          }
        }

        if (!targetWallet) {
          return safeSend(chatId, `❌ Wallet not found: ${addressArg}`);
        }

        const result: boolean = await tracker.removeWallet(
          targetWallet.address,
        );

        if (result) {
          await safeSend(
            chatId,
            '✅ Wallet Removed\n\n' +
              `Name: ${targetWallet.name ?? 'Wallet'}\n` +
              `Address: ${targetWallet.address.slice(0, 12)}...\n\n` +
              'No longer tracking trades',
          );
        } else {
          await safeSend(chatId, '❌ Failed to remove wallet');
        }
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    // /stats
    bot.onText(/\/stats/, async msg => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      if (!redis) {
        await safeSend(chatId, '❌ Redis not initialized');
        return;
      }

      try {
        const { RiskManager } = await import('./riskManager.js');
        const riskManager = new RiskManager(redis);
        const stats = await riskManager.getDailyStats();

        if (!stats || stats.totalTrades === 0) {
          return safeSend(chatId, '🔭 No trades today yet');
        }

        await safeSend(
          chatId,
          "📊 Today's Performance\n\n" +
            `Total Trades: ${stats.totalTrades}\n` +
            `Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
            `Win Rate: ${stats.winRate}\n` +
            `Total P&L: ${stats.totalPnL} SOL\n` +
            `Avg P&L: ${stats.avgPnL} SOL\n` +
            `Best: ${stats.biggestWin} SOL\n` +
            `Worst: ${stats.biggestLoss} SOL`,
        );
      } catch (error: any) {
        await safeSend(chatId, `❌ Error: ${error?.message ?? String(error)}`);
      }
    });

    bot.on('polling_error', error => {
      console.log('Telegram polling error:', (error as any)?.message ?? error);
    });

    console.log('✅ Telegram bot commands registered');
  } catch (error: any) {
    console.error(
      '❌ Failed to initialize Telegram bot:',
      error?.message ?? String(error),
    );
  }
}

// Helper público para otros módulos
export async function sendTelegramAlert(
  chatId: string | number | undefined,
  message: string,
  silent = false,
): Promise<void> {
  await safeSend(chatId, message, silent);
}
