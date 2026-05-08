import { NextResponse } from 'next/server'
import { fetchInsiderPurchases } from '@/app/lib/edgar'
import { notifySlack } from '@/app/lib/slack-notify'

// Allow up to 60 s on Vercel (Pro/Hobby limit)
export const maxDuration = 60

export async function GET(req: Request) {
  // Optional static API-key guard (set INSIDER_BUYS_API_KEY env var to enable)
  const apiKey = process.env.INSIDER_BUYS_API_KEY
  if (apiKey) {
    const provided =
      new URL(req.url).searchParams.get('key') ??
      req.headers.get('x-api-key')
    if (provided !== apiKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const { searchParams } = new URL(req.url)

  // ?minValue=100000   — override the $100 k floor
  const minValue = Math.max(0, Number(searchParams.get('minValue') ?? 100_000))
  // ?notify=false      — suppress Slack message (useful for ad-hoc queries)
  const notify = searchParams.get('notify') !== 'false'

  try {
    const now = new Date()
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().slice(0, 10)

    const purchases = await fetchInsiderPurchases(minValue)

    if (notify) {
      await notifySlack(purchases, fmt(since), fmt(now))
    }

    return NextResponse.json({
      success: true,
      count: purchases.length,
      dateRange: { start: fmt(since), end: fmt(now) },
      purchases,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[insider-buys] Error:', err)
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    )
  }
}
