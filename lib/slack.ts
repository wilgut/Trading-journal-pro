import type { InsiderPurchase } from './edgar'

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const currencyExact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function formatBlock(p: InsiderPurchase, rank: number) {
  const shares = p.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })
  const ticker = p.issuerTicker || p.issuerName
  const lines = [
    `*${rank}. ${ticker}* — ${currency.format(p.totalValue)}`,
    `${p.ownerName}  ·  ${p.ownerTitle}`,
    `${shares} shares @ ${currencyExact.format(p.pricePerShare)}  ·  ${p.transactionDate}`,
    `<${p.filingUrl}|View SEC Filing>`,
  ].join('\n')

  return { type: 'section', text: { type: 'mrkdwn', text: lines } }
}

export async function sendInsiderPurchaseAlert(
  purchases: InsiderPurchase[],
  webhookUrl = process.env.SLACK_WEBHOOK_URL ?? ''
): Promise<void> {
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not configured')

  if (!purchases.length) {
    await postToSlack(webhookUrl, {
      text: '📊 Insider Purchases (last 24 h): no qualifying purchases found.',
    })
    return
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const total = purchases.reduce((s, p) => s + p.totalValue, 0)
  const shown = purchases.slice(0, 20)

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🏦 Insider Purchases  ·  ${dateStr}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${purchases.length} purchase${purchases.length === 1 ? '' : 's'} > $100 k in the last 24 h* — combined value: *${currency.format(total)}*`,
      },
    },
    { type: 'divider' },
    ...shown.map((p, i) => formatBlock(p, i + 1)),
  ]

  if (purchases.length > 20) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_…and ${purchases.length - 20} more. Showing top 20 by value._`,
      },
    })
  }

  await postToSlack(webhookUrl, {
    text: `🏦 ${purchases.length} insider purchase${purchases.length === 1 ? '' : 's'} >$100 k — top: ${purchases[0].issuerTicker || purchases[0].issuerName} ${currency.format(purchases[0].totalValue)}`,
    blocks,
  })
}

async function postToSlack(webhookUrl: string, payload: unknown): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Slack webhook returned ${res.status}: ${body}`)
  }
}
