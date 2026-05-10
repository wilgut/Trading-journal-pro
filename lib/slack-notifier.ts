import type { InsiderBuy } from './edgar'

function fmtCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

function fmtShares(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function buildSlackPayload(buys: InsiderBuy[]): object {
  if (buys.length === 0) {
    return {
      text: '📊 *SEC Insider Buys — Last 24 Hours*\nNo qualifying open-market purchases found (>$100K).',
    }
  }

  const totalValue = buys.reduce((sum, b) => sum + b.totalValue, 0)
  const pluralPurchases = buys.length === 1 ? 'purchase' : 'purchases'

  const header =
    `📈 *SEC Insider Buys — Last 24 Hours*\n` +
    `${buys.length} qualifying ${pluralPurchases} · Total: *${fmtCurrency(totalValue)}* · Minimum: $100K`

  // Slack block text has a 3,000-char limit — show top 20
  const topBuys = buys.slice(0, 20)
  const rows = topBuys
    .map((buy, i) => {
      const ticker = buy.issuerTicker
        ? `*${buy.issuerTicker}* (${buy.issuerName})`
        : `*${buy.issuerName}*`
      return [
        `${i + 1}. ${ticker}`,
        `   ${buy.reporterName} · ${buy.reporterTitle}`,
        `   ${fmtShares(buy.shares)} shares @ $${buy.pricePerShare.toFixed(2)} = *${fmtCurrency(buy.totalValue)}*`,
        `   📅 ${buy.transactionDate}  |  <${buy.filingUrl}|View SEC Filing>`,
      ].join('\n')
    })
    .join('\n\n')

  const blocks: object[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: header },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: rows },
    },
  ]

  if (buys.length > 20) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${buys.length - 20} more purchases not shown. Call the API for the full list._`,
        },
      ],
    })
  }

  return { blocks }
}

export async function sendSlackNotification(buys: InsiderBuy[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set')

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSlackPayload(buys)),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Slack webhook returned ${res.status}: ${body}`)
  }
}
