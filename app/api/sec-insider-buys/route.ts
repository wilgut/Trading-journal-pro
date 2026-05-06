import { NextResponse } from 'next/server'
import { formatDate, subDays } from 'date-fns'
import { getInsiderPurchases, formatSlackReport } from '@/lib/edgar'

const SLACK_API = 'https://slack.com/api/chat.postMessage'
const SLACK_CHANNEL = process.env.SLACK_INSIDER_CHANNEL ?? 'C0AUARBCPND' // #sec-form4-insider-scanner

export const dynamic = 'force-dynamic'

/**
 * GET /api/sec-insider-buys
 *
 * Fetches SEC Form 4 filings from the last 24 hours, filters for open-market
 * purchases ≥ $100,000, ranks them by total value, and posts the summary to
 * the configured Slack channel.
 *
 * Query params:
 *   minValue  – minimum transaction value in USD  (default: 100000)
 *   dryRun    – if "true", return the report as JSON without posting to Slack
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minValue = Number(searchParams.get('minValue') ?? 100_000)
  const dryRun = searchParams.get('dryRun') === 'true'

  const today = new Date()
  const yesterday = subDays(today, 1)
  const toDate = formatDate(today, 'yyyy-MM-dd')
  const fromDate = formatDate(yesterday, 'yyyy-MM-dd')
  const reportDate = toDate

  try {
    const purchases = await getInsiderPurchases({ fromDate, toDate, minValue })
    const message = formatSlackReport(purchases, reportDate)

    if (dryRun) {
      return NextResponse.json({ reportDate, count: purchases.length, purchases, message })
    }

    const slackToken = process.env.SLACK_BOT_TOKEN
    if (!slackToken) {
      return NextResponse.json(
        { error: 'SLACK_BOT_TOKEN not configured', message },
        { status: 500 }
      )
    }

    const slackRes = await fetch(SLACK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${slackToken}`,
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL,
        text: message,
        mrkdwn: true,
        unfurl_links: false,
      }),
    })

    const slackData = await slackRes.json()

    if (!slackData.ok) {
      return NextResponse.json(
        { error: `Slack error: ${slackData.error}`, message },
        { status: 502 }
      )
    }

    return NextResponse.json({
      ok: true,
      reportDate,
      count: purchases.length,
      slackTs: slackData.ts,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
