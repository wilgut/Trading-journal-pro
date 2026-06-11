import { NextResponse } from 'next/server'
import { fetchRecentInsiderPurchases } from '@/lib/sec-edgar'
import { buildInsiderTradesMessage, sendToSlackWebhook } from '@/lib/slack-notify'

// GET /api/insider-trades
// Query params:
//   minValue   – minimum purchase value in USD (default 100000)
//   slackOnly  – if "true", suppress JSON output (useful for cron pings)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minValue = Number(searchParams.get('minValue') ?? 100_000)

  try {
    const trades = await fetchRecentInsiderPurchases(minValue)

    const webhookUrl = process.env.SLACK_WEBHOOK_URL
    let slackSent = false

    if (webhookUrl) {
      const message = buildInsiderTradesMessage(trades)
      await sendToSlackWebhook(webhookUrl, message)
      slackSent = true
    }

    if (searchParams.get('slackOnly') === 'true') {
      return NextResponse.json({ ok: true, count: trades.length, slackSent })
    }

    return NextResponse.json({ count: trades.length, slackSent, trades })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
