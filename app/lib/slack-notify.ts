import type { InsiderPurchase } from './edgar'

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const CHANNEL = process.env.SLACK_CHANNEL ?? '#trading-alerts'

function money(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

function commas(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

type SlackBlock = Record<string, unknown>

function buildBlocks(
  purchases: InsiderPurchase[],
  startDate: string,
  endDate: string,
): SlackBlock[] {
  const generated = new Date().toUTCString()

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'SEC Insider Purchases — Last 24 Hours',
        emoji: false,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Range:* ${startDate} – ${endDate}  |  *Min:* $100,000  |  ` +
          `*Found:* ${purchases.length} purchase(s)\n_${generated}_`,
      },
    },
    { type: 'divider' },
  ]

  if (purchases.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_No qualifying insider purchases found in this period._',
      },
    })
    return blocks
  }

  // Slack allows max 50 blocks; show top 20 to stay well within that
  const top = purchases.slice(0, 20)

  top.forEach((p, i) => {
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text:
            `*#${i + 1}  ${p.ticker}  —  ${p.companyName}*\n` +
            `${p.insiderName}  _(${p.insiderTitle})_`,
        },
        {
          type: 'mrkdwn',
          text:
            `*${money(p.totalValue)}*\n` +
            `${commas(p.shares)} shares @ $${p.pricePerShare.toFixed(2)}\n` +
            `${p.transactionDate}`,
        },
      ],
    })
    if (i < top.length - 1) blocks.push({ type: 'divider' })
  })

  if (purchases.length > 20) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${purchases.length - 20} more purchases not shown. ` +
            `Call \`GET /api/insider-buys\` for the full list._`,
        },
      ],
    })
  }

  return blocks
}

export async function notifySlack(
  purchases: InsiderPurchase[],
  startDate: string,
  endDate: string,
): Promise<void> {
  if (!WEBHOOK_URL && !BOT_TOKEN) {
    console.warn(
      '[insider-buys] No Slack credentials found ' +
        '(SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN) — skipping notification',
    )
    return
  }

  const blocks = buildBlocks(purchases, startDate, endDate)

  if (WEBHOOK_URL) {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    })
    if (!res.ok)
      throw new Error(
        `Slack webhook error: ${res.status} ${await res.text()}`,
      )
    return
  }

  // Fall back to Bot Token + Web API
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: CHANNEL, blocks }),
  })
  const json = (await res.json()) as { ok: boolean; error?: string }
  if (!json.ok) throw new Error(`Slack API error: ${json.error}`)
}
