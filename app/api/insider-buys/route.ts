/**
 * GET /api/insider-buys
 *
 * Query params:
 *   minValue   – minimum purchase value in USD (default 100000)
 *   maxFilings – max Form 4 filings to process (default 80)
 *   sendSlack  – "true" to also POST results to Slack
 *
 * Env vars (needed when sendSlack=true):
 *   SLACK_WEBHOOK_URL  – Incoming Webhook URL, OR
 *   SLACK_BOT_TOKEN + SLACK_CHANNEL_ID – Web API token + channel
 */

import { NextResponse } from 'next/server'
import { fetchInsiderPurchases } from '@/lib/edgar'
import {
  buildSlackMessage,
  sendToSlackWebhook,
  sendToSlackChannel,
} from '@/lib/slack-notify'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes – EDGAR fetches take time

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minValue = Number(searchParams.get('minValue') ?? 100_000)
  const maxFilings = Number(searchParams.get('maxFilings') ?? 80)
  const sendSlack = searchParams.get('sendSlack') === 'true'

  try {
    const purchases = await fetchInsiderPurchases(minValue, maxFilings)

    if (sendSlack) {
      const payload = buildSlackMessage(purchases)
      const webhookUrl = process.env.SLACK_WEBHOOK_URL
      const botToken = process.env.SLACK_BOT_TOKEN
      const channelId = process.env.SLACK_CHANNEL_ID

      if (webhookUrl) {
        await sendToSlackWebhook(payload, webhookUrl)
      } else if (botToken && channelId) {
        await sendToSlackChannel(payload, channelId, botToken)
      } else {
        return NextResponse.json(
          {
            error:
              'Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN + SLACK_CHANNEL_ID to enable Slack posting.',
          },
          { status: 400 }
        )
      }
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      count: purchases.length,
      minValue,
      slackSent: sendSlack,
      purchases,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
