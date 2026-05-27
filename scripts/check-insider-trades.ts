#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
//  SEC EDGAR Insider Trades — CLI Runner
//
//  Usage:
//    npx tsx scripts/check-insider-trades.ts
//    npx tsx scripts/check-insider-trades.ts --hours 48 --min 500000
//    npx tsx scripts/check-insider-trades.ts --no-slack   (print only)
//
//  Environment variables:
//    SLACK_WEBHOOK_URL   Incoming Webhook URL  (recommended)
//    SLACK_BOT_TOKEN     Bot token             (alternative)
//    SLACK_CHANNEL       Channel to post to    (default: #general)
//    CONTACT_EMAIL       Email in User-Agent sent to EDGAR
//
//  Add to package.json scripts:
//    "insider-trades": "tsx scripts/check-insider-trades.ts"
//
//  Cron (crontab -e):
//    0 6 * * 1-5  cd /path/to/app && npx tsx scripts/check-insider-trades.ts
// ─────────────────────────────────────────────────────────────────────────────

import { runInsiderTradesReport, buildSlackMessage, fmtMoney } from '../lib/insider-trades'

// ── Parse CLI flags ───────────────────────────────────────────────────────────

const args  = process.argv.slice(2)
const flag  = (name: string, fallback: string) =>
  args[args.indexOf(name) + 1] ?? fallback
const bool  = (name: string, fallback: boolean) =>
  args.includes(name) ? !name.startsWith('--no-') : fallback

const hoursBack = Number(flag('--hours', '24'))
const minValue  = Number(flag('--min',   '100000'))
const doSlack   = !args.includes('--no-slack')

// ── Main ──────────────────────────────────────────────────────────────────────

;(async () => {
  console.log('━'.repeat(60))
  console.log('  SEC EDGAR — Significant Insider Purchases')
  console.log(`  Window: last ${hoursBack}h  |  Min: ${fmtMoney(minValue)}`)
  console.log('━'.repeat(60))
  console.log()

  try {
    const summary = await runInsiderTradesReport({
      hoursBack,
      minValue,
      notify: doSlack,
    })

    // ── Console output ────────────────────────────────────────────────────
    if (summary.trades.length === 0) {
      console.log(`No qualifying purchases found in the last ${hoursBack} hours.`)
    } else {
      console.log(`Found ${summary.totalPurchases} purchases totaling ${fmtMoney(summary.totalValue)}\n`)

      for (const t of summary.trades) {
        console.log(
          `  ${t.rank.toString().padStart(2)}. ` +
          `[${(t.ticker || t.companyName).padEnd(6)}] ` +
          `${fmtMoney(t.totalValue).padEnd(12)} ` +
          `— ${t.insiderName} (${t.insiderTitle})`
        )
      }
    }

    console.log()
    if (doSlack) {
      console.log('✅ Slack notification sent.')
    } else {
      console.log('ℹ️  Slack notification skipped (--no-slack).')
      console.log('\n── Slack preview ──\n')
      console.log(buildSlackMessage(summary))
    }

  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
})()
