import { NextResponse } from 'next/server'
import { getInsiderPurchases, InsiderPurchase } from '@/lib/edgar'

function fmtMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

function buildSlackBlocks(purchases: InsiderPurchase[], minValue: number, hoursBack: number) {
  const MEDALS = ['🥇', '🥈', '🥉']
  const totalValue = purchases.reduce((s, p) => s + p.totalValue, 0)
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })

  const headerText =
    `📊 *Insider Purchases — Last ${hoursBack}h* _(min ${fmtMoney(minValue)})_\n${dateStr}`

  if (purchases.length === 0) {
    return {
      text: headerText,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: headerText } },
        { type: 'section', text: { type: 'mrkdwn', text: '_No qualifying open-market purchases found._' } },
      ],
    }
  }

  const rows = purchases.slice(0, 15).map((p, i) => {
    const medal = MEDALS[i] ?? `${i + 1}.`
    const ticker = p.ticker ? ` \`${p.ticker}\`` : ''
    const title = p.insiderTitle ? ` _(${p.insiderTitle})_` : ''
    return (
      `${medal} *${p.insiderName}*${title} — *${p.companyName}*${ticker}\n` +
      `   ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${fmtMoney(p.totalValue)}*\n` +
      `   Date: ${p.transactionDate} · Filed: ${p.filedAt} · <${p.filingUrl}|SEC Filing>`
    )
  })

  const footer =
    `_${purchases.length} qualifying purchase${purchases.length !== 1 ? 's' : ''} · ` +
    `Total value: *${fmtMoney(totalValue)}*_`

  return {
    text: headerText,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: headerText } },
      { type: 'divider' },
      ...rows.map(r => ({ type: 'section', text: { type: 'mrkdwn', text: r } })),
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: footer } },
    ],
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minValue = Number(searchParams.get('minValue') ?? 100_000)
  const hoursBack = Number(searchParams.get('hoursBack') ?? 24)
  const sendToSlack = searchParams.get('slack') === 'true'

  try {
    const purchases = await getInsiderPurchases(minValue, hoursBack)
    const payload = buildSlackBlocks(purchases, minValue, hoursBack)

    if (sendToSlack) {
      const webhookUrl = process.env.SLACK_WEBHOOK_URL
      if (!webhookUrl) {
        return NextResponse.json(
          { error: 'SLACK_WEBHOOK_URL env var is not set' },
          { status: 500 },
        )
      }
      const slackRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!slackRes.ok) {
        const body = await slackRes.text()
        return NextResponse.json({ error: `Slack responded ${slackRes.status}: ${body}` }, { status: 502 })
      }
    }

    return NextResponse.json({
      count: purchases.length,
      totalValue: purchases.reduce((s, p) => s + p.totalValue, 0),
      purchases,
      slackPosted: sendToSlack,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
