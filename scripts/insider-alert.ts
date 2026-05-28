/**
 * Standalone insider-purchase alert script.
 *
 * Usage:
 *   npx tsx scripts/insider-alert.ts
 *
 * Environment variables:
 *   EDGAR_USER_AGENT   - Required by EDGAR (default: TradingJournalPro contact@...)
 *   SLACK_WEBHOOK_URL  - Incoming-webhook URL to post the summary
 *   MIN_VALUE          - Minimum transaction value in USD (default: 100000)
 *   HOURS_BACK         - How far back to look in hours (default: 24)
 *
 * Schedule with cron (runs daily at 6 PM ET):
 *   0 18 * * 1-5  cd /path/to/project && npx tsx scripts/insider-alert.ts
 */

import { getInsiderPurchases, InsiderPurchase } from '../lib/edgar'

const MIN_VALUE = Number(process.env.MIN_VALUE ?? 100_000)
const HOURS_BACK = Number(process.env.HOURS_BACK ?? 24)
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

function buildSlackPayload(purchases: InsiderPurchase[]) {
  const MEDALS = ['🥇', '🥈', '🥉']
  const total = purchases.reduce((s, p) => s + p.totalValue, 0)
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  })

  const header = `📊 *Insider Purchases — Last ${HOURS_BACK}h* _(min ${fmt(MIN_VALUE)})_\n${dateStr}`

  if (purchases.length === 0) {
    return { text: header + '\n\n_No qualifying open-market purchases found._' }
  }

  const rows = purchases.slice(0, 15).map((p, i) => {
    const medal = MEDALS[i] ?? `${i + 1}.`
    const ticker = p.ticker ? ` \`${p.ticker}\`` : ''
    const title = p.insiderTitle ? ` _(${p.insiderTitle})_` : ''
    return (
      `${medal} *${p.insiderName}*${title} — *${p.companyName}*${ticker}\n` +
      `   ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${fmt(p.totalValue)}*\n` +
      `   Date: ${p.transactionDate} · Filed: ${p.filedAt} · <${p.filingUrl}|SEC Filing>`
    )
  })

  const footer =
    `_${purchases.length} qualifying purchase${purchases.length !== 1 ? 's' : ''} · ` +
    `Total: *${fmt(total)}*_`

  return {
    text: header,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: header } },
      { type: 'divider' },
      ...rows.map(r => ({ type: 'section', text: { type: 'mrkdwn', text: r } })),
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: footer } },
    ],
  }
}

async function main() {
  console.log(`\n📊 Insider Purchase Scanner`)
  console.log(`   Looking back: ${HOURS_BACK}h   Min value: ${fmt(MIN_VALUE)}\n`)

  const purchases = await getInsiderPurchases(MIN_VALUE, HOURS_BACK)

  if (purchases.length === 0) {
    console.log('No qualifying purchases found.')
  } else {
    console.log(`Found ${purchases.length} qualifying purchase(s):\n`)
    purchases.forEach((p, i) => {
      console.log(
        `${i + 1}. ${p.insiderName} (${p.insiderTitle})\n` +
        `   ${p.companyName} (${p.ticker})\n` +
        `   ${p.shares.toLocaleString()} × $${p.pricePerShare.toFixed(2)} = ${fmt(p.totalValue)}\n` +
        `   Filed: ${p.filedAt}  |  ${p.filingUrl}\n`,
      )
    })
  }

  if (!SLACK_WEBHOOK) {
    console.log('SLACK_WEBHOOK_URL not set — skipping Slack post.')
    return
  }

  const payload = buildSlackPayload(purchases)
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (res.ok) {
    console.log('✅ Posted to Slack.')
  } else {
    console.error(`❌ Slack post failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
