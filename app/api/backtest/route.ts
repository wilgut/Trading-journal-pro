import { NextResponse } from 'next/server'
import { runBacktest } from '@/lib/backtest'
import { getUniverse, type UniverseKey } from '@/lib/universe'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function parseUniverse(value: string | null): UniverseKey {
  if (value === 'sp500' || value === 'combined') return value
  return 'nasdaq100'
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  const universeKey = parseUniverse(searchParams.get('universe'))
  const topN = Math.min(
    100,
    Math.max(5, Number(searchParams.get('topN')) || 20)
  )
  const frequency =
    searchParams.get('frequency') === 'monthly' ? 'monthly' : 'weekly'
  const benchmark = (searchParams.get('benchmark') || 'SPY').toUpperCase()
  const currentYear = new Date().getUTCFullYear()
  const startYear = Math.min(
    currentYear - 2,
    Math.max(2006, Number(searchParams.get('startYear')) || 2019)
  )

  try {
    const result = await runBacktest({
      symbols: getUniverse(universeKey),
      benchmark,
      topN,
      frequency,
      startYear,
      momentumWeight: 0.75,
      lowVolWeight: 0.25,
    })
    return NextResponse.json({ universe: universeKey, ...result })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Error ejecutando el backtest.',
      },
      { status: 502 }
    )
  }
}
