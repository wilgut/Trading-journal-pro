import type { InsiderBuy } from './edgar-insider'

function fmtDollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function fmtShares(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export async function sendInsiderBuysToSlack(buys: InsiderBuy[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not configured')

  const totalValue = buys.reduce((s, b) => s + b.totalValue, 0)
  const dateLabel = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  if (!buys.length) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*Insider Buys — ${dateLabel}*\nNo qualifying purchases (>$100K by executives or directors) found in the last 24 hours.`,
      }),
    })
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Insider Buying Alert — ${dateLabel}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `*${buys.length} qualifying purchase${buys.length !== 1 ? 's' : ''}* ` +
            `by executives & directors  |  Combined value: *${fmtDollars(totalValue)}*  |  Min: $100K`,
        },
      ],
    },
    { type: 'divider' },
  ]

  const shown = buys.slice(0, 20)
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i]
    const ticker = b.ticker ? ` (${b.ticker})` : ''
    const role = b.insiderTitle || (b.isDirector ? 'Director' : 'Officer')
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${i + 1}. ${b.insiderName}* — ${role}`,
          `Bought *${fmtDollars(b.totalValue)}* of *${b.companyName}${ticker}*`,
          `${fmtShares(b.shares)} shares @ $${b.pricePerShare.toFixed(2)}  •  ${b.transactionDate}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'SEC Filing' },
        url: b.filingUrl,
      },
    })
  }

  if (buys.length > 20) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_…and ${buys.length - 20} more purchases not shown_` },
      ],
    })
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Slack webhook failed (${res.status}): ${body}`)
  }
}
