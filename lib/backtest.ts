// Motor de backtest walk-forward para la estrategia de ranking.
//
// El backtest reconstruye los factores de PRECIO (Momentum + Low Volatility)
// punto-en-el-tiempo a partir del histórico de cotizaciones. Estos son los
// únicos factores reconstruibles sin datos fundamentales históricos (que las
// fuentes gratuitas no ofrecen point-in-time). En cada fecha de rebalanceo se
// selecciona el top-N, se mantiene equiponderado hasta el siguiente rebalanceo
// y se compara contra el benchmark.

import { annualizedVolatilityAt, momentumAt } from './factors'
import { mean, std, winsorizedZScores } from './stats'
import { fetchChart, pool, type PriceSeries } from './yahoo'

export interface BacktestParams {
  symbols: string[]
  benchmark: string
  topN: number
  frequency: 'weekly' | 'monthly'
  startYear: number
  momentumWeight: number
  lowVolWeight: number
}

export interface BacktestMetrics {
  cagr: number
  sharpe: number
  maxDrawdown: number
  volatility: number
  totalReturn: number
}

export interface BacktestResult {
  frequency: string
  topN: number
  benchmark: string
  start: string
  end: string
  periods: number
  hitRate: number
  avgTurnover: number
  annualTurnover: number
  portfolio: BacktestMetrics
  benchmarkMetrics: BacktestMetrics
  beatsBenchmark: boolean
  excessCagr: number
  coverage: number
  sampleHoldings: string[]
  equityCurve: { date: string; portfolio: number; benchmark: number }[]
}

const DAY_MS = 86_400_000
const TD_YEAR = 252

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// Índice mayor cuyo timestamp es <= target (-1 si no existe).
function idxOnOrBefore(dates: number[], target: number): number {
  let lo = 0
  let hi = dates.length - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid] <= target) {
      res = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return res
}

// Calendario de rebalanceo: viernes (semanal) o fin de mes (mensual).
function rebalanceCalendar(
  start: Date,
  end: Date,
  freq: 'weekly' | 'monthly'
): number[] {
  const out: number[] = []
  if (freq === 'weekly') {
    const d = new Date(start)
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1)
    while (d <= end) {
      out.push(d.getTime())
      d.setUTCDate(d.getUTCDate() + 7)
    }
  } else {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
    while (d <= end) {
      const last = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      )
      if (last >= start && last <= end) out.push(last.getTime())
      d.setUTCMonth(d.getUTCMonth() + 1)
    }
  }
  return out
}

function computeMetrics(
  returns: number[],
  periodsPerYear: number
): BacktestMetrics {
  if (returns.length === 0) {
    return {
      cagr: 0,
      sharpe: 0,
      maxDrawdown: 0,
      volatility: 0,
      totalReturn: 0,
    }
  }
  let equity = 1
  let peak = 1
  let maxDD = 0
  for (const r of returns) {
    equity *= 1 + r
    peak = Math.max(peak, equity)
    maxDD = Math.min(maxDD, equity / peak - 1)
  }
  const years = returns.length / periodsPerYear
  const cagr = years > 0 && equity > 0 ? Math.pow(equity, 1 / years) - 1 : 0
  const m = mean(returns)
  const s = std(returns)
  return {
    cagr,
    sharpe: s > 0 ? (m / s) * Math.sqrt(periodsPerYear) : 0,
    maxDrawdown: maxDD,
    volatility: s * Math.sqrt(periodsPerYear),
    totalReturn: equity - 1,
  }
}

export async function runBacktest(
  params: BacktestParams
): Promise<BacktestResult> {
  const end = new Date()
  const start = new Date(Date.UTC(params.startYear, 0, 1))
  const period2 = Math.floor(end.getTime() / 1000)
  // 430 días extra de margen para el lookback de momentum (12 meses).
  const period1 = Math.floor((start.getTime() - 430 * DAY_MS) / 1000)

  const allSymbols = [...new Set([...params.symbols, params.benchmark])]
  const series = new Map<string, PriceSeries>()
  await pool(allSymbols, 10, async (sym) => {
    const s = await fetchChart(sym, { period1, period2, interval: '1d' })
    if (s && s.closes.length > TD_YEAR + 10) series.set(sym, s)
  })

  const bench = series.get(params.benchmark)
  if (!bench) {
    throw new Error(
      `Sin datos de precio para el benchmark ${params.benchmark}.`
    )
  }

  const universe = params.symbols.filter((s) => series.has(s))
  if (universe.length < params.topN) {
    throw new Error(
      `Datos insuficientes: solo ${universe.length} acciones con histórico.`
    )
  }

  const rebals = rebalanceCalendar(start, end, params.frequency).filter(
    (t) => idxOnOrBefore(bench.dates, t) >= TD_YEAR
  )
  if (rebals.length < 3) {
    throw new Error('Rango de fechas insuficiente para el backtest.')
  }

  const periodsPerYear = params.frequency === 'weekly' ? 52 : 12
  const wMom = params.momentumWeight
  const wVol = params.lowVolWeight
  const wSum = wMom + wVol || 1

  const portReturns: number[] = []
  const benchReturns: number[] = []
  const turnovers: number[] = []
  const equityCurve: BacktestResult['equityCurve'] = [
    { date: isoDate(rebals[0]), portfolio: 1, benchmark: 1 },
  ]
  let prevHoldings = new Set<string>()
  let lastHoldings: string[] = []
  let portEquity = 1
  let benchEquity = 1

  for (let k = 0; k < rebals.length - 1; k++) {
    const t = rebals[k]
    const tNext = rebals[k + 1]

    // Puntuar el universo con datos hasta la fecha t.
    const valid: string[] = []
    const mom12: (number | null)[] = []
    const mom6: (number | null)[] = []
    const vols: (number | null)[] = []
    for (const sym of universe) {
      const s = series.get(sym)!
      const i = idxOnOrBefore(s.dates, t)
      if (i < TD_YEAR) continue
      const mm = momentumAt(s.closes, i)
      const vv = annualizedVolatilityAt(s.closes, i)
      if (mm.mom12_1 == null || vv == null) continue
      valid.push(sym)
      mom12.push(mm.mom12_1)
      mom6.push(mm.mom6_1)
      vols.push(vv)
    }
    if (valid.length < params.topN) continue

    const zMom12 = winsorizedZScores(mom12, true)
    const zMom6 = winsorizedZScores(mom6, true)
    const zVol = winsorizedZScores(vols, false)

    const scored = valid
      .map((sym, j) => {
        const momParts = [zMom12[j], zMom6[j]].filter(
          (x): x is number => x != null
        )
        const momScore = momParts.length
          ? momParts.reduce((a, b) => a + b, 0) / momParts.length
          : 0
        const volScore = zVol[j] ?? 0
        return { sym, score: (wMom * momScore + wVol * volScore) / wSum }
      })
      .sort((a, b) => b.score - a.score)

    const holdings = scored.slice(0, params.topN).map((x) => x.sym)
    lastHoldings = holdings

    // Retorno equiponderado de la cartera de t a tNext.
    const rets: number[] = []
    for (const sym of holdings) {
      const s = series.get(sym)!
      const i0 = idxOnOrBefore(s.dates, t)
      const i1 = idxOnOrBefore(s.dates, tNext)
      if (i0 >= 0 && i1 > i0) {
        const r = s.closes[i1] / s.closes[i0] - 1
        if (Number.isFinite(r)) rets.push(r)
      }
    }
    if (rets.length === 0) continue
    const portRet = mean(rets)

    const b0 = idxOnOrBefore(bench.dates, t)
    const b1 = idxOnOrBefore(bench.dates, tNext)
    const benchRet =
      b0 >= 0 && b1 > b0 ? bench.closes[b1] / bench.closes[b0] - 1 : 0

    portReturns.push(portRet)
    benchReturns.push(benchRet)
    portEquity *= 1 + portRet
    benchEquity *= 1 + benchRet
    equityCurve.push({
      date: isoDate(tNext),
      portfolio: portEquity,
      benchmark: benchEquity,
    })

    // Turnover: fracción de posiciones nuevas respecto al rebalanceo anterior.
    const current = new Set(holdings)
    if (prevHoldings.size > 0) {
      let changed = 0
      for (const h of current) if (!prevHoldings.has(h)) changed++
      turnovers.push(changed / Math.max(current.size, 1))
    }
    prevHoldings = current
  }

  if (portReturns.length < 2) {
    throw new Error('No se generaron suficientes periodos de inversión.')
  }

  const portfolio = computeMetrics(portReturns, periodsPerYear)
  const benchmarkMetrics = computeMetrics(benchReturns, periodsPerYear)
  const wins = portReturns.filter((r, i) => r > benchReturns[i]).length
  const avgTurnover = turnovers.length ? mean(turnovers) : 0

  return {
    frequency: params.frequency,
    topN: params.topN,
    benchmark: params.benchmark,
    start: isoDate(rebals[0]),
    end: isoDate(rebals[rebals.length - 1]),
    periods: portReturns.length,
    hitRate: wins / portReturns.length,
    avgTurnover,
    annualTurnover: avgTurnover * periodsPerYear,
    portfolio,
    benchmarkMetrics,
    beatsBenchmark: portfolio.cagr > benchmarkMetrics.cagr,
    excessCagr: portfolio.cagr - benchmarkMetrics.cagr,
    coverage: universe.length / params.symbols.length,
    sampleHoldings: lastHoldings,
    equityCurve,
  }
}
