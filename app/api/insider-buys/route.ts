import { NextResponse } from 'next/server'
import { fetchInsiderBuys } from '@/lib/edgar-insider'
import { sendInsiderBuysToSlack } from '@/lib/slack-notify'

// Vercel: allow up to 5 min for the EDGAR + Slack round-trip
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const hours = Math.min(Number(searchParams.get('hours') ?? 24), 72)
  const notify = searchParams.get('notify') !== 'false'

  try {
    const buys = await fetchInsiderBuys(hours)

    if (notify) {
      await sendInsiderBuysToSlack(buys)
    }

    return NextResponse.json({
      count: buys.length,
      totalValue: buys.reduce((s, b) => s + b.totalValue, 0),
      hoursBack: hours,
      slackSent: notify,
      buys,
    })
  } catch (err) {
    console.error('[insider-buys]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 },
    )
  }
}
