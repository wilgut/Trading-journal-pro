import { NextResponse } from 'next/server'
import type { InsiderPurchase } from '../route'

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function medal(rank: number): string {
  return rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : `${rank + 1}.`
}

function buildBlocks(
  purchases: InsiderPurchase[],
  meta: { count: number; totalFilingsScanned: number; dateRange: { from: string; to: string }; asOf: string }
) {
  const dateLabel = new Date(meta.asOf).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  if (purchases.length === 0) {
    return {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🏦 Insider Buying — ${dateLabel}`, emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `No executive/director open-market purchases >$100K found in the last 24 hours (scanned ${meta.totalFilingsScanned} Form 4 filings).`,
          },
        },
      ],
    }
  }

  const top = purchases.slice(0, 10)
  const rows = top
    .map(
      (p, i) =>
        `${medal(i)} *${p.ticker}* — ${p.insiderName} _(${p.insiderTitle})_\n` +
        `   Bought *${p.shares.toLocaleString()} shares* @ $${p.pricePerShare.toFixed(2)} = *${fmt(p.totalValue)}*`
    )
    .join('\n\n')

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🏦 Insider Buying Alert — ${dateLabel}`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${meta.count}* executive/director open-market purchases >$100K in the last 24 hours (${meta.totalFilingsScanned} Form 4 filings scanned). Top ${top.length} by value:`,
        },
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: rows } },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Source: SEC EDGAR Form 4 | Date range: ${meta.dateRange.from} → ${meta.dateRange.to} | As of ${new Date(meta.asOf).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ET`,
          },
        ],
      },
    ],
  }
}

export async function POST(req: Request) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return NextResponse.json(
      { error: 'SLACK_WEBHOOK_URL environment variable is not configured' },
      { status: 500 }
    )
  }

  // Fetch insider buying data from the sibling route
  const origin = new URL(req.url).origin
  const dataRes = await fetch(`${origin}/api/insider-buying`, { method: 'GET' })

  if (!dataRes.ok) {
    return NextResponse.json(
      { error: 'Failed to fetch insider buying data from SEC EDGAR' },
      { status: 502 }
    )
  }

  const body = await dataRes.json()
  const { purchases, count, totalFilingsScanned, dateRange, asOf } = body

  const message = buildBlocks(purchases as InsiderPurchase[], {
    count,
    totalFilingsScanned,
    dateRange,
    asOf,
  })

  const slackRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  })

  if (!slackRes.ok) {
    const text = await slackRes.text()
    return NextResponse.json(
      { error: `Slack rejected the message: ${text}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, purchasesSent: count })
}
