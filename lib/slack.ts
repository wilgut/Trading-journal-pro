import type { InsiderBuy } from './edgar'

// process.env is available at runtime in Next.js; declare it for TypeScript
// when @types/node is not yet installed.
declare const process: { env: Record<string, string | undefined> }

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string } }
  | { type: 'divider' }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }

const MAX_ENTRIES = 25 // Slack caps messages at 50 blocks; 25 buys + header/dividers fits safely

function fmt$$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n.toFixed(0)}`
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const [, month, day] = iso.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`
}

function buildBlocks(buys: InsiderBuy[]): SlackBlock[] {
  const now = new Date().toUTCString().replace(/:\d\d GMT/, ' UTC')
  const display = buys.slice(0, MAX_ENTRIES)

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📈 Insider Buys > $100k — Last 24h' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${buys.length} purchase${buys.length !== 1 ? 's' : ''} found · ${now}`,
        },
      ],
    },
    { type: 'divider' },
  ]

  display.forEach((b, i) => {
    const rank = i + 1
    const value = fmt$$(b.totalValue)
    const shares = b.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })
    const price = b.pricePerShare.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    })
    const date = fmtDate(b.transactionDate)
    const label = b.ticker ? `*${b.ticker}*` : `*${b.companyName}*`

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${rank}. ${label} — *+${value}*\n` +
          `${b.executiveName} (${b.title}) · ${shares} shares @ ${price}${date ? ` · ${date}` : ''}\n` +
          `<${b.filingUrl}|View SEC Filing>`,
      },
    })
  })

  if (buys.length > MAX_ENTRIES) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${buys.length - MAX_ENTRIES} more. Showing top ${MAX_ENTRIES} by value._`,
        },
      ],
    })
  }

  return blocks
}

export async function sendSlackSummary(buys: InsiderBuy[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('[slack] SLACK_WEBHOOK_URL not set — skipping notification')
    return
  }

  const blocks = buys.length > 0
    ? buildBlocks(buys)
    : [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: ':mag: No insider purchases over $100k found in the last 24 hours.',
          },
        },
      ]

  const fallbackText =
    buys.length > 0
      ? `Insider Buys > $100k: ${buys.length} purchase(s) found. Top: ${buys[0]?.ticker} +${fmt$$(buys[0]?.totalValue ?? 0)}`
      : 'No insider purchases over $100k found in the last 24 hours.'

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallbackText, blocks }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Slack webhook error ${res.status}: ${body}`)
  }
}
