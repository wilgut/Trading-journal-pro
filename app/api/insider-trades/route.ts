import { NextRequest, NextResponse } from 'next/server'
import {
  scanInsiderPurchases,
  buildSlackMessage,
  postToSlack,
} from '@/lib/edgar-insider-scanner'

// Allow up to 5 minutes — EDGAR scans across hundreds of filings
export const maxDuration = 300

/**
 * GET /api/insider-trades
 *
 * Scans SEC EDGAR Form 4 filings from the last 24 h, filters for
 * open-market purchases > $100 k, and (optionally) sends a ranked
 * summary to Slack.
 *
 * Query params:
 *   slackOnly=true  — respond with 204 after posting; skip JSON body
 *
 * Environment:
 *   SLACK_WEBHOOK_URL  — incoming-webhook URL (optional)
 */
export async function GET(req: NextRequest) {
  try {
    const purchases   = await scanInsiderPurchases()
    const message     = buildSlackMessage(purchases)
    const webhookUrl  = process.env.SLACK_WEBHOOK_URL
    let   slackSent   = false

    if (webhookUrl) {
      await postToSlack(message, webhookUrl)
      slackSent = true
    }

    if (req.nextUrl.searchParams.get('slackOnly') === 'true' && slackSent) {
      return new NextResponse(null, { status: 204 })
    }

    return NextResponse.json({
      success:   true,
      count:     purchases.length,
      slackSent,
      purchases,
    })
  } catch (err) {
    console.error('[insider-trades]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
