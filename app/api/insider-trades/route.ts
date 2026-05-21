/**
 * GET /api/insider-trades
 *
 * Fetches SEC EDGAR Form 4 filings for the last 24 hours, filters for
 * open-market purchases > $100 K by executives / directors, ranks them by
 * total value, and sends a summary to Slack.
 *
 * Query params:
 *   startDate  YYYY-MM-DD  (default: yesterday UTC)
 *   endDate    YYYY-MM-DD  (default: today UTC)
 *   maxFilings number      (default: 200)
 *   slack      "false"     skip Slack notification
 */

import { NextResponse } from 'next/server'
import { fetchInsiderPurchases } from '@/lib/edgar'
import { buildSlackMessage, postToSlack } from '@/lib/slack'

export const dynamic = 'force-dynamic' // Never cache this route

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const todayStr = now.toISOString().split('T')[0]
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  const startDate = searchParams.get('startDate') ?? yesterdayStr
  const endDate = searchParams.get('endDate') ?? todayStr
  const maxFilings = Math.min(parseInt(searchParams.get('maxFilings') ?? '200', 10), 500)
  const sendSlack = searchParams.get('slack') !== 'false'

  try {
    const trades = await fetchInsiderPurchases(startDate, endDate, maxFilings)

    const slackMessage = buildSlackMessage(trades, { startDate, endDate })
    const slackResult = sendSlack
      ? await postToSlack(slackMessage)
      : { sent: false, method: 'none' as const, error: 'Skipped via ?slack=false' }

    return NextResponse.json({
      success: true,
      dateRange: { startDate, endDate },
      filingsFetched: maxFilings,
      qualifyingPurchases: trades.length,
      slack: slackResult,
      trades,
    })
  } catch (err) {
    console.error('[insider-trades] Error:', err)
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 })
  }
}
