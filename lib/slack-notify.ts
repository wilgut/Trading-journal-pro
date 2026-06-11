import type { InsiderTrade } from './sec-edgar'

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function fmtDate(s: string): string {
  if (!s) return ''
  try {
    return new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return s
  }
}

export function buildInsiderTradesMessage(trades: InsiderTrade[]): string {
  const asOf = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const top = trades.slice(0, 15)

  const lines: string[] = [
    `:bar_chart: *SEC Insider Purchases — Last 24 Hours* | ${asOf}`,
    `_Open-market purchases > $100K  |  Showing top ${top.length} of ${trades.length} qualifying filings_`,
    '',
  ]

  if (top.length === 0) {
    lines.push('_No qualifying purchases found in this period._')
  } else {
    top.forEach((t, i) => {
      const ticker = t.ticker ? ` *(${t.ticker})*` : ''
      const shares = t.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })
      lines.push(
        `*${i + 1}.  ${t.companyName}${ticker}   ${fmtUSD(t.totalValue)}*`,
        `     :bust_in_silhouette:  ${t.insiderName}  |  ${t.insiderTitle}`,
        `     ${shares} shares @ $${t.pricePerShare.toFixed(2)}  |  ${fmtDate(t.transactionDate)}`,
        `     :link: <${t.filingUrl}|SEC Filing>`,
        ''
      )
    })
  }

  return lines.join('\n')
}

export async function sendToSlackWebhook(
  webhookUrl: string,
  message: string
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })
  if (!res.ok) {
    throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`)
  }
}
