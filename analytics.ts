// analytics.ts - Sistema de análisis de trading tipo Tradezella
import type { Redis as RedisClient } from 'ioredis';

// --- INTERFACES DE DATOS ---

/**
 * Define la estructura de un objeto 'trade' como se espera
 * que se almacene (probablemente como JSON string en Redis).
 * La hemos extendido ligeramente para soportar:
 *  - modo: DRY / LIVE
 *  - fuente de entrada (SNIPER / COPY / MANUAL)
 *  - dex de salida (PUMPFUN / PUMPSWAP / JUPITER / RAYDIUM)
 *  - etiqueta de estrategia (ADAPTIVE, LEGACY, etc.)
 */
export interface Trade {
  symbol: string;
  entryTime: string; // Timestamp en string (ms epoch)
  exitTime?: string; // Timestamp en string (opcional)
  entryPrice: string;
  exitPrice?: string; // Opcional
  solAmount: string;
  pnlSOL?: string; // Opcional
  pnlPercent?: string; // Opcional
  reason?: string; // Motivo de salida (TRAILING_STOP, STOP_LOSS, TIMEOUT, etc.)

  // NUEVOS CAMPOS (opcionales, no rompen nada si no se usan)
  mode?: 'DRY' | 'LIVE';      // Para distinguir dry-run de real
  entrySource?: string;       // 'SNIPER' | 'COPY' | 'MANUAL' | ...
  dex?: string;               // 'PUMPFUN' | 'PUMPSWAP' | 'JUPITER' | ...
  strategyTag?: string;       // 'ADAPTIVE' | 'LEGACY' | ...
}

/**
 * Define la estructura del objeto de estadísticas generales.
 */
export interface OverallStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  avgReturn: string;
  totalPnL: string;
  profitFactor: string;
  bestTrade: {
    symbol: string;
    pnl: string;
    return: string;
    reason?: string;
  } | null;
  worstTrade: {
    symbol: string;
    pnl: string;
    return: string;
    reason?: string;
  } | null;
}

/**
 * Estructura para los datos de rendimiento por razón de salida.
 */
interface ExitReasonStats {
  reason: string;
  count: number;
  winRate: string;
  avgPnL: string;
  totalPnL: string;
}

/**
 * Estructura interna para agregar datos por razón.
 */
interface ReasonData {
  count: number;
  totalPnL: number;
  wins: number;
  losses: number;
}

/**
 * Estructura para los datos de rendimiento por hora.
 */
interface HourStats {
  hour: string;
  count: number;
  winRate: string;
  avgPnL: string;
  totalPnL: string;
}

/**
 * Estructura interna para agregar datos por hora.
 */
interface HourData {
  count: number;
  totalPnL: number;
  wins: number;
}

/**
 * Estructura para el análisis de tiempo de 'hold'.
 */
interface HoldTimeStats {
  duration: string;
  count: number;
  winRate: string;
  avgPnL: string;
  totalPnL: string;
}

/**
 * Estructura interna para agregar datos por tiempo de 'hold'.
 */
interface HoldTimeData {
  count: number;
  totalPnL: number;
  wins: number;
}

// Tipos para los 'buckets' de tiempo
type HoldTimeBucket = '0-5min' | '5-10min' | '10-20min' | '20-30min' | '30min+';


// --- CLASE DE ANALÍTICAS ---

export class TradingAnalytics {

  // Usamos el atajo de constructor de TypeScript
  // para declarar y asignar 'redis' como una propiedad privada.
  constructor(private redis: RedisClient) {}

  /**
   * Obtener todas las operaciones de un período.
   * @param startDate Fecha de inicio (string ISO)
   * @param endDate Fecha de fin (string ISO, opcional)
   * @returns Promesa con un array de Trades
   */
  public async getTrades(startDate: string, endDate: string | null = null): Promise<Trade[]> {
    try {
      const trades: Trade[] = [];
      const start = new Date(startDate);
      const end = endDate ? new Date(endDate) : new Date();

      const current = new Date(start);
      while (current <= end) {
        const dateKey = current.toISOString().split('T')[0];
        const dayTrades = await this.redis.lrange(`trades:${dateKey}`, 0, -1);

        for (const tradeJson of dayTrades) {
          trades.push(JSON.parse(tradeJson) as Trade);
        }

        current.setDate(current.getDate() + 1);
      }

      return trades;
    } catch (error: any) {
      console.error('Error getting trades:', error?.message ?? error);
      return [];
    }
  }

  /**
   * Estadísticas generales (como Tradezella).
   * @param days Número de días hacia atrás a consultar (default: 30)
   * @returns Promesa con el objeto OverallStats
   */
  public async getOverallStats(days: number = 30): Promise<OverallStats> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString());

    if (trades.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: '0%',
        avgReturn: '0%',
        totalPnL: '0 SOL',
        profitFactor: 'N/A',
        bestTrade: null,
        worstTrade: null,
      };
    }

    let wins = 0;
    let losses = 0;
    let totalPnL = 0;
    let totalReturnPercent = 0;
    let bestTrade: Trade | null = null;
    let worstTrade: Trade | null = null;

    for (const trade of trades) {
      const pnl = parseFloat(trade.pnlSOL || '0');
      const returnPercent = parseFloat(trade.pnlPercent || '0');

      totalPnL += pnl;
      totalReturnPercent += returnPercent;

      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;

      if (!bestTrade || pnl > parseFloat(bestTrade.pnlSOL || '0')) {
        bestTrade = trade;
      }
      if (!worstTrade || pnl < parseFloat(worstTrade.pnlSOL || '0')) {
        worstTrade = trade;
      }
    }

    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const avgReturn = (totalReturnPercent / trades.length).toFixed(2);

    const totalWins = trades
      .filter((t) => parseFloat(t.pnlSOL || '0') > 0)
      .reduce((sum, t) => sum + parseFloat(t.pnlSOL || '0'), 0);
    const totalLosses = Math.abs(
      trades
        .filter((t) => parseFloat(t.pnlSOL || '0') < 0)
        .reduce((sum, t) => sum + parseFloat(t.pnlSOL || '0'), 0),
    );
    const profitFactor = totalLosses > 0 ? (totalWins / totalLosses).toFixed(2) : 'N/A';

    return {
      totalTrades: trades.length,
      wins,
      losses,
      winRate: `${winRate}%`,
      avgReturn: `${avgReturn}%`,
      totalPnL: `${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(4)} SOL`,
      profitFactor,
      bestTrade: bestTrade
        ? {
            symbol: bestTrade.symbol,
            pnl: parseFloat(bestTrade.pnlSOL || '0').toFixed(4),
            return: `${parseFloat(bestTrade.pnlPercent || '0').toFixed(2)}%`,
            reason: bestTrade.reason,
          }
        : null,
      worstTrade: worstTrade
        ? {
            symbol: worstTrade.symbol,
            pnl: parseFloat(worstTrade.pnlSOL || '0').toFixed(4),
            return: `${parseFloat(worstTrade.pnlPercent || '0').toFixed(2)}%`,
            reason: worstTrade.reason,
          }
        : null,
    };
  }

  /**
   * Rendimiento por razón de salida.
   * @param days Número de días hacia atrás (default: 30)
   * @returns Promesa con un array de ExitReasonStats
   */
  public async getPerformanceByExitReason(days: number = 30): Promise<ExitReasonStats[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const trades = await this.getTrades(startDate.toISOString());

    const byReason: Record<string, ReasonData> = {};

    for (const trade of trades) {
      const reason = trade.reason || 'unknown';
      if (!byReason[reason]) {
        byReason[reason] = { count: 0, totalPnL: 0, wins: 0, losses: 0 };
      }

      byReason[reason].count++;
      const pnl = parseFloat(trade.pnlSOL || '0');
      byReason[reason].totalPnL += pnl;
      if (pnl > 0) byReason[reason].wins++;
      else if (pnl < 0) byReason[reason].losses++;
    }

    const results: ExitReasonStats[] = [];
    for (const [reason, data] of Object.entries(byReason)) {
      const winRate =
        data.count > 0 ? ((data.wins / data.count) * 100).toFixed(1) : '0.0';
      const avgPnL =
        data.count > 0 ? (data.totalPnL / data.count).toFixed(4) : '0.0000';

      results.push({
        reason,
        count: data.count,
        winRate: `${winRate}%`,
        avgPnL: `${avgPnL} SOL`,
        totalPnL: `${data.totalPnL >= 0 ? '+' : ''}${data.totalPnL.toFixed(4)} SOL`,
      });
    }

    // parseFloat funciona porque ignora " SOL" al final
    return results.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));
  }

  /**
   * Mejores y peores horas del día (basado en entryTime).
   * @param days Número de días hacia atrás (default: 30)
   * @returns Promesa con un array de HourStats
   */
  public async getPerformanceByHour(days: number = 30): Promise<HourStats[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const trades = await this.getTrades(startDate.toISOString());

    const byHour: Record<number, HourData> = {};

    for (const trade of trades) {
      if (!trade.entryTime) continue;

      const hour = new Date(parseInt(trade.entryTime)).getHours();
      if (!byHour[hour]) {
        byHour[hour] = { count: 0, totalPnL: 0, wins: 0 };
      }

      byHour[hour].count++;
      const pnl = parseFloat(trade.pnlSOL || '0');
      byHour[hour].totalPnL += pnl;
      if (pnl > 0) byHour[hour].wins++;
    }

    const results: HourStats[] = [];
    for (const [hourKey, data] of Object.entries(byHour)) {
      const winRate =
        data.count > 0 ? ((data.wins / data.count) * 100).toFixed(1) : '0.0';
      const avgPnL =
        data.count > 0 ? (data.totalPnL / data.count).toFixed(4) : '0.0000';

      results.push({
        hour: `${hourKey.padStart(2, '0')}:00`,
        count: data.count,
        winRate: `${winRate}%`,
        avgPnL: `${avgPnL} SOL`,
        totalPnL: `${data.totalPnL >= 0 ? '+' : ''}${data.totalPnL.toFixed(4)} SOL`,
      });
    }

    return results.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));
  }

  /**
   * Análisis de duración de trades.
   * @param days Número de días hacia atrás (default: 30)
   * @returns Promesa con un array de HoldTimeStats
   */
  public async getHoldTimeAnalysis(days: number = 30): Promise<HoldTimeStats[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const trades = await this.getTrades(startDate.toISOString());

    const holdTimes: Record<HoldTimeBucket, HoldTimeData> = {
      '0-5min': { count: 0, totalPnL: 0, wins: 0 },
      '5-10min': { count: 0, totalPnL: 0, wins: 0 },
      '10-20min': { count: 0, totalPnL: 0, wins: 0 },
      '20-30min': { count: 0, totalPnL: 0, wins: 0 },
      '30min+': { count: 0, totalPnL: 0, wins: 0 },
    };

    for (const trade of trades) {
      if (!trade.entryTime || !trade.exitTime) continue;

      const duration =
        (parseInt(trade.exitTime) - parseInt(trade.entryTime)) / 60000; // minutos
      const pnl = parseFloat(trade.pnlSOL || '0');

      let bucket: HoldTimeBucket;
      if (duration <= 5) bucket = '0-5min';
      else if (duration <= 10) bucket = '5-10min';
      else if (duration <= 20) bucket = '10-20min';
      else if (duration <= 30) bucket = '20-30min';
      else bucket = '30min+';

      holdTimes[bucket].count++;
      holdTimes[bucket].totalPnL += pnl;
      if (pnl > 0) holdTimes[bucket].wins++;
    }

    const results: HoldTimeStats[] = [];
    for (const [bucket, data] of Object.entries(holdTimes) as [
      HoldTimeBucket,
      HoldTimeData,
    ][]) {
      if (data.count === 0) continue;

      const winRate = ((data.wins / data.count) * 100).toFixed(1);
      const avgPnL = (data.totalPnL / data.count).toFixed(4);

      results.push({
        duration: bucket,
        count: data.count,
        winRate: `${winRate}%`,
        avgPnL: `${avgPnL} SOL`,
        totalPnL: `${data.totalPnL >= 0 ? '+' : ''}${data.totalPnL.toFixed(4)} SOL`,
      });
    }

    return results;
  }

  /**
   * Generar reporte completo en la consola.
   * @param days Número de días hacia atrás (default: 30)
   * @returns Promesa vacía (void)
   */
  public async generateFullReport(days: number = 30): Promise<void> {
    console.log(`\n📊 ========== TRADING REPORT (Last ${days} days) ==========\n`);

    const overall = await this.getOverallStats(days);
    console.log('📈 OVERALL PERFORMANCE:');
    console.log(`   Total Trades: ${overall.totalTrades}`);
    console.log(
      `   Win Rate: ${overall.winRate} (${overall.wins}W / ${overall.losses}L)`,
    );
    console.log(`   Total P&L: ${overall.totalPnL}`);
    console.log(`   Avg Return: ${overall.avgReturn}`);
    console.log(`   Profit Factor: ${overall.profitFactor}`);

    if (overall.bestTrade) {
      console.log(`\n   🏆 Best Trade: ${overall.bestTrade.symbol}`);
      console.log(
        `      P&L: +${overall.bestTrade.pnl} SOL (${overall.bestTrade.return})`,
      );
    }

    if (overall.worstTrade) {
      console.log(`\n   💀 Worst Trade: ${overall.worstTrade.symbol}`);
      console.log(
        `      P&L: ${overall.worstTrade.pnl} SOL (${overall.worstTrade.return})`,
      );
    }

    const byReason = await this.getPerformanceByExitReason(days);
    if (byReason.length > 0) {
      console.log(`\n📋 PERFORMANCE BY EXIT REASON:`);
      byReason.forEach((r) => {
        console.log(
          `   ${r.reason}: ${r.count} trades, ${r.winRate} win rate, ${r.totalPnL}`,
        );
      });
    }

    const byHour = await this.getPerformanceByHour(days);
    if (byHour.length > 0) {
      console.log(`\n🕐 BEST/WORST HOURS:`);
      console.log(
        `   Best: ${byHour[0].hour} (${byHour[0].count} trades, ${byHour[0].totalPnL})`,
      );
      if (byHour.length > 1) {
        console.log(
          `   Worst: ${byHour[byHour.length - 1].hour} (${byHour[byHour.length - 1].count} trades, ${byHour[byHour.length - 1].totalPnL})`,
        );
      }
    }

    const holdTime = await this.getHoldTimeAnalysis(days);
    if (holdTime.length > 0) {
      console.log(`\n⏱️ HOLD TIME ANALYSIS:`);
      holdTime.forEach((h) => {
        console.log(
          `   ${h.duration}: ${h.count} trades, ${h.winRate} win rate, ${h.avgPnL} avg`,
        );
      });
    }

    console.log(`\n========================================\n`);
  }

  /**
   * Exportar a CSV (para importar en Tradezella).
   * @param days Número de días hacia atrás (default: 30)
   * @returns Promesa con el contenido del CSV como string
   */
  public async exportToCSV(days: number = 30): Promise<string> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const trades = await this.getTrades(startDate.toISOString());

    // Ampliamos el CSV para incluir modo, entrySource, dex, strategyTag
    let csv =
      'Symbol,Entry Time,Exit Time,Entry Price,Exit Price,SOL Amount,PnL SOL,PnL %,Exit Reason,Duration (min),Mode,Entry Source,DEX,Strategy\n';

    for (const trade of trades) {
      const entryTimeIso = new Date(parseInt(trade.entryTime)).toISOString();
      const exitTimeIso = trade.exitTime
        ? new Date(parseInt(trade.exitTime)).toISOString()
        : 'N/A';
      const duration =
        trade.entryTime && trade.exitTime
          ? (
              (parseInt(trade.exitTime) - parseInt(trade.entryTime)) /
              60000
            ).toFixed(1)
          : 'N/A';

      csv += `${trade.symbol || 'UNKNOWN'},`;
      csv += `${entryTimeIso},`;
      csv += `${exitTimeIso},`;
      csv += `${parseFloat(trade.entryPrice).toFixed(8)},`;
      csv += `${
        trade.exitPrice ? parseFloat(trade.exitPrice).toFixed(8) : 'N/A'
      },`;
      csv += `${parseFloat(trade.solAmount).toFixed(4)},`;
      csv += `${parseFloat(trade.pnlSOL || '0').toFixed(4)},`;
      csv += `${parseFloat(trade.pnlPercent || '0').toFixed(2)},`;
      csv += `${trade.reason || 'unknown'},`;
      csv += `${duration},`;
      csv += `${trade.mode ?? ''},`;
      csv += `${trade.entrySource ?? ''},`;
      csv += `${trade.dex ?? ''},`;
      csv += `${trade.strategyTag ?? ''}\n`;
    }

    return csv;
  }
}
