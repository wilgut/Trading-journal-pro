import type { InsiderTrade } from './edgar'

// ---------------------------------------------------------------------------
// Slack message formatter
// ---------------------------------------------------------------------------

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  return `$${(n / 1_000).toFixed(0)}K`
}

function fmtShares(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
    ? `${(n / 1_000).toFixed(1)}K`
    : n.toLocaleString()
}

export function buildSlackMessage(trades: InsiderTrade[], dateRange: { startDate: string; endDate: string }): string {
  const totalCount = trades.length
  const top = trades.slice(0, 20) // Cap at top 20 for readability
  const label = dateRange.startDate === dateRange.endDate ? dateRange.startDate : `${dateRange.startDate} → ${dateRange.endDate}`

  if (totalCount === 0) {
    return (
      `:bar_chart: *Insider Purchases >$100K — ${label}*\n` +
      `_No qualifying open-market insider purchases found._`
    )
  }

  const rows = top.map((t, i) => {
    const rank = i + 1
    const identifier = t.ticker ? `*${t.ticker}*` : `*${t.companyName}*`
    const companyFull = t.ticker && t.companyName ? ` (${t.companyName})` : ''
    const titleParts = [t.ownerTitle]
    const roleTag = t.isDirector && t.isOfficer ? ' [Dir+Officer]' : t.isDirector ? ' [Director]' : t.isOfficer ? ' [Officer]' : ''

    return (
      `*${rank}.* ${identifier}${companyFull} — ${fmtMoney(t.totalValue)}\n` +
      `   :bust_in_silhouette: ${t.ownerName}${roleTag} · ${titleParts.join(', ')}\n` +
      `   ${fmtShares(t.shares)} shares @ $${t.pricePerShare.toFixed(2)} · ${t.transactionDate}\n` +
      `   <${t.filingUrl}|:page_facing_up: SEC Filing>`
    )
  })

  const hiddenCount = totalCount - top.length
  const footer = hiddenCount > 0 ? `\n_…and ${hiddenCount} more qualifying purchase(s)_` : ''

  return (
    `:chart_with_upwards_trend: *Insider Purchases >$100K — ${label}*\n` +
    `_${totalCount} qualifying purchase(s) · ranked by total value_\n\n` +
    rows.join('\n\n') +
    footer
  )
}

// ---------------------------------------------------------------------------
// Slack delivery
// ---------------------------------------------------------------------------

export interface SlackResult {
  sent: boolean
  method: 'webhook' | 'bot' | 'none'
  error?: string
}

/**
 * Posts a message to Slack.
 *
 * Supports two auth modes (checked in order):
 *   1. Incoming Webhook  → SLACK_WEBHOOK_URL
 *   2. Bot Token         → SLACK_BOT_TOKEN + SLACK_CHANNEL_ID
 */
export async function postToSlack(message: string): Promise<SlackResult> {
  // --- Incoming Webhook (simpler, no OAuth scopes needed) ---
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      })
      if (res.ok) return { sent: true, method: 'webhook' }
      const text = await res.text()
      return { sent: false, method: 'webhook', error: `HTTP ${res.status}: ${text}` }
    } catch (err) {
      return { sent: false, method: 'webhook', error: String(err) }
    }
  }

  // --- Bot Token (chat.postMessage) ---
  const botToken = process.env.SLACK_BOT_TOKEN
  const channelId = process.env.SLACK_CHANNEL_ID
  if (botToken && channelId) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel: channelId, text: message }),
      })
      const json = await res.json() as { ok: boolean; error?: string }
      if (json.ok) return { sent: true, method: 'bot' }
      return { sent: false, method: 'bot', error: json.error }
    } catch (err) {
      return { sent: false, method: 'bot', error: String(err) }
    }
  }

  return { sent: false, method: 'none', error: 'No Slack credentials configured (set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN + SLACK_CHANNEL_ID)' }
}
