import { NextResponse } from 'next/server'
import { annualizedVolatility, momentum } from '@/lib/factors'
import { buildRanking } from '@/lib/scoring'
import {
  DEFAULT_WEIGHTS,
  FACTOR_KEYS,
  type FactorWeights,
  type RawMetrics,
  type SymbolData,
} from '@/lib/types'
import { getUniverse, indicesOf, type UniverseKey } from '@/lib/universe'
import { fetchChart, fetchFundamentals, pool } from '@/lib/yahoo'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function parseUniverse(value: string | null): UniverseKey {
  if (value === 'sp500' || value === 'nasdaq100') return value
  return 'combined'
}

function parseWeights(sp: URLSearchParams): FactorWeights {
  const raw: Partial<FactorWeights> = {}
  let provided = false
  for (const f of FACTOR_KEYS) {
    const v = sp.get(f)
    if (v != null && Number.isFinite(Number(v))) {
      raw[f] = Math.max(0, Number(v))
      provided = true
    }
  }
  if (!provided) return DEFAULT_WEIGHTS
  const merged = { ...DEFAULT_WEIGHTS, ...raw }
  const sum = FACTOR_KEYS.reduce((a, f) => a + merged[f], 0)
  if (sum <= 0) return DEFAULT_WEIGHTS
  const out = {} as FactorWeights
  for (const f of FACTOR_KEYS) out[f] = merged[f] / sum
  return out
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const universeKey = parseUniverse(searchParams.get('universe'))
  const weights = parseWeights(searchParams)
  const tickers = getUniverse(universeKey)

  let data: SymbolData[]
  try {
    data = await pool(tickers, 8, async (symbol): Promise<SymbolData> => {
      const [chart, fund] = await Promise.all([
        fetchChart(symbol, { range: '2y', interval: '1d' }),
        fetchFundamentals(symbol),
      ])
      const closes = chart?.closes ?? []
      const mom = momentum(closes)
      const vol = annualizedVolatility(closes)

      const pe = fund?.trailingPE ?? null
      const pb = fund?.priceToBook ?? null
      const marketCap = fund?.marketCap ?? null
      const fcf = fund?.freeCashflow ?? null

      const metrics: RawMetrics = {
        mom12_1: mom.mom12_1,
        mom6_1: mom.mom6_1,
        volatility: vol,
        beta: fund?.beta ?? null,
        earningsYield: pe != null && pe > 0 ? 1 / pe : null,
        bookToPrice: pb != null && pb > 0 ? 1 / pb : null,
        fcfYield:
          fcf != null && marketCap != null && marketCap > 0
            ? fcf / marketCap
            : null,
        roe: fund?.returnOnEquity ?? null,
        profitMargin: fund?.profitMargin ?? null,
        debtToEquity: fund?.debtToEquity ?? null,
        revenueGrowth: fund?.revenueGrowth ?? null,
        earningsGrowth: fund?.earningsGrowth ?? null,
      }

      return {
        symbol,
        name: fund?.name ?? symbol,
        sector: fund?.sector ?? null,
        price:
          fund?.price ?? (closes.length ? closes[closes.length - 1] : null),
        marketCap,
        indices: indicesOf(symbol),
        metrics,
        hasPrice: closes.length > 0,
        hasFundamentals: fund != null,
      }
    })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Error descargando datos de mercado.',
      },
      { status: 502 }
    )
  }

  const usable = data.filter((d) => d.hasPrice)
  if (usable.length === 0) {
    return NextResponse.json(
      {
        error:
          'No se pudieron descargar precios de Yahoo Finance. ' +
          'Revisa la conectividad de red del entorno.',
      },
      { status: 502 }
    )
  }

  const ranking = buildRanking(usable, weights)

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    universe: universeKey,
    weights,
    requested: tickers.length,
    priceCoverage: usable.length,
    fundamentalsCoverage: usable.filter((d) => d.hasFundamentals).length,
    count: ranking.length,
    ranking,
  })
}
