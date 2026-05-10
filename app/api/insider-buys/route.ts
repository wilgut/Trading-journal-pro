import { NextResponse } from 'next/server'
import { getInsiderBuys } from '@/lib/edgar'
import { buildSlackPayload, sendSlackNotification } from '@/lib/slack-notifier'

// Increase timeout for hosting environments that support it (e.g. Vercel Pro)
export const maxDuration = 300

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minValue = Number(searchParams.get('minValue') ?? 100_000)
  // Pass notify=false to skip Slack and just get the JSON response
  const notifySlack = searchParams.get('notify') !== 'false'

  try {
    const buys = await getInsiderBuys(minValue)

    let slackSent = false
    if (notifySlack && process.env.SLACK_WEBHOOK_URL) {
      await sendSlackNotification(buys)
      slackSent = true
    }

    return NextResponse.json({
      success: true,
      count: buys.length,
      slackSent,
      purchases: buys,
      // Preview the Slack payload without sending it
      slackPreview: buildSlackPayload(buys),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
