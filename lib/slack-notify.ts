/**
 * Sends a pre-formatted insider-purchase summary to a Slack channel
 * via an Incoming Webhook URL (set SLACK_WEBHOOK_URL in env).
 *
 * For the built-in Slack bot token flow, set SLACK_BOT_TOKEN + SLACK_CHANNEL_ID.
 */

import { InsiderPurchase, formatCurrency } from './edgar'

export function buildSlackMessage(
  purchases: InsiderPurchase[],
  generatedAt: Date = new Date()
): object {
  const dateStr = generatedAt.toUTCString()

  if (purchases.length === 0) {
    return {
      text: `*SEC Insider Purchases — Last 24 Hours*\n_No purchases above $100K found. Generated: ${dateStr}_`,
    }
  }

  const headerBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: '🔍 SEC Insider Purchases — Last 24 Hours (>$100K)',
      emoji: true,
    },
  }

  const metaBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Source: *SEC EDGAR Form 4* | Generated: ${dateStr} | Showing top ${purchases.length} purchase${purchases.length !== 1 ? 's' : ''}`,
      },
    ],
  }

  const divider = { type: 'divider' }

  const purchaseBlocks = purchases.flatMap((p) => [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*#${p.rank}  ${p.issuerName}${p.issuerTicker ? ` (${p.issuerTicker})` : ''}*`,
          `👤 *${p.insiderName}* — ${p.insiderTitle}`,
          `📊 ${p.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })} shares @ $${p.pricePerShare.toFixed(2)} = *${formatCurrency(p.totalValue)}*`,
          `📅 ${p.transactionDate}`,
        ].join('\n'),
      },
    },
    divider,
  ])

  const footerBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_Open-market purchases only (Form 4, Transaction Code P). Directors & Officers only. Minimum $100K._`,
      },
    ],
  }

  return {
    blocks: [headerBlock, metaBlock, divider, ...purchaseBlocks, footerBlock],
    text: `SEC Insider Purchases — Last 24 Hours: ${purchases.length} significant purchase(s) found.`,
  }
}

/** Posts the payload to a Slack Incoming Webhook URL. */
export async function sendToSlackWebhook(
  payload: object,
  webhookUrl: string
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Slack webhook error ${res.status}: ${text}`)
  }
}

/** Posts the payload using the Slack Web API (bot token). */
export async function sendToSlackChannel(
  payload: object,
  channelId: string,
  botToken: string
): Promise<void> {
  const body = { channel: channelId, ...payload }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { ok: boolean; error?: string }
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`)
}
