#!/usr/bin/env -S npx tsx
/**
 * Standalone CLI script — run directly without starting the Next.js server.
 *
 * Usage:
 *   npx tsx scripts/edgar-insider-trades.ts
 *
 * Slack:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... npx tsx scripts/edgar-insider-trades.ts
 */

import path from 'path'
import { fileURLToPath } from 'url'

// Ensure the project root is on the module resolution path when run via tsx
const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.chdir(path.resolve(__dirname, '..'))

// Dynamic import resolves the path alias after cwd is set
const { scanInsiderPurchases, buildSlackMessage, postToSlack, MIN_PURCHASE_VALUE } =
  await import('../lib/edgar-insider-scanner.js')

// ─────────────────────────────────────────────────────────────────────────────

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

async function main() {
  console.log('═'.repeat(62))
  console.log('  SEC EDGAR Insider Purchase Scanner')
  console.log(`  Threshold: ≥ $${MIN_PURCHASE_VALUE.toLocaleString()}  •  Window: last 24 h`)
  console.log('═'.repeat(62))
  console.log()

  const purchases = await scanInsiderPurchases()

  if (!purchases.length) {
    console.log('No qualifying purchases found.')
  } else {
    const MEDALS = ['🥇', '🥈', '🥉']
    purchases.forEach((p, i) => {
      const rank   = MEDALS[i] ?? `#${i + 1}`
      const ticker = p.issuerTicker ? ` (${p.issuerTicker})` : ''
      console.log(`${rank}  ${p.issuerName}${ticker}`)
      console.log(`    Reporter : ${p.reporterName} [${p.reporterTitle}]`)
      console.log(`    Purchase : ${p.shares.toLocaleString()} sh × ${usd(p.pricePerShare)} = ${usd(p.totalValue)}`)
      console.log(`    Date     : ${p.transactionDate}`)
      console.log(`    Filing   : ${p.filingUrl}`)
      console.log()
    })
  }

  const message    = buildSlackMessage(purchases)
  const webhookUrl = process.env.SLACK_WEBHOOK_URL

  if (webhookUrl) {
    await postToSlack(message, webhookUrl)
    console.log('✅  Summary posted to Slack.')
  } else {
    console.log('ℹ️   Set SLACK_WEBHOOK_URL to post to Slack.\n')
    console.log('─── Slack message preview ─────────────────────────────────')
    // Strip Slack-specific markup for readability in the terminal
    console.log(message.replace(/[*_]/g, '').replace(/<([^|>]+)\|([^>]+)>/g, '$2'))
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
