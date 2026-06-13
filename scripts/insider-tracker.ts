#!/usr/bin/env node
/**
 * Standalone CLI script — run via:
 *   npx tsx scripts/insider-tracker.ts
 *   npx tsx scripts/insider-tracker.ts --dry-run   (prints Slack payload, does not send)
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL  — Slack Incoming Webhook URL
 *
 * Optional env vars:
 *   INSIDER_MAX_FILINGS  — cap on Form 4 filings to scan (default: 500)
 */

import {
  formatDate,
  formatCurrency,
  gatherInsiderPurchases,
  buildSlackPayload,
  buildEmptySlackPayload,
  sendSlackMessage,
  type TrackerStats,
} from '../lib/insider-tracker';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_FILINGS = parseInt(process.env['INSIDER_MAX_FILINGS'] ?? '500', 10);

async function main(): Promise<void> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = formatDate(yesterday);
  const endDate = formatDate(now);
  const dateRange = `${startDate} → ${endDate}`;

  console.log('');
  console.log('🔍  SEC EDGAR Insider Purchase Tracker');
  console.log(`📅  Period : ${dateRange}`);
  console.log(`💰  Filter : open-market purchases > $100,000`);
  if (DRY_RUN) console.log('⚠️   DRY RUN — Slack message will NOT be sent');
  console.log('');

  const stats: TrackerStats = {
    filingsFound: 0,
    filingsProcessed: 0,
    purchasesOver100k: 0,
    totalValue: 0,
  };

  const purchases = await gatherInsiderPurchases(startDate, endDate, {
    maxFilings: MAX_FILINGS,
    onProgress: (msg) => console.log(`  ${msg}`),
    stats,
  });

  console.log('');
  console.log('── Results ─────────────────────────────────────────────────');
  console.log(`  Filings found    : ${stats.filingsFound}`);
  console.log(`  Filings parsed   : ${stats.filingsProcessed}`);
  console.log(`  Purchases > $100K: ${stats.purchasesOver100k}`);
  console.log(`  Total value      : ${formatCurrency(stats.totalValue)}`);
  console.log('────────────────────────────────────────────────────────────');

  if (purchases.length === 0) {
    console.log('\n  No significant purchases found.\n');
    if (!DRY_RUN) {
      await sendSlackMessage(buildEmptySlackPayload(dateRange));
      console.log('📢  Slack notified (empty result).');
    }
    return;
  }

  // Print top-10 table to console
  const COL = { ticker: 8, company: 32, value: 13, insider: 30 };
  const line = '─'.repeat(COL.ticker + COL.company + COL.value + COL.insider + 3);

  console.log(`\nTop ${Math.min(10, purchases.length)} purchases:\n${line}`);
  console.log(
    'Ticker  '.padEnd(COL.ticker) +
      'Company'.padEnd(COL.company) +
      'Value'.padStart(COL.value) +
      '   Insider (Role)',
  );
  console.log(line);

  purchases.slice(0, 10).forEach((p, i) => {
    const ticker = p.ticker ? `[${p.ticker}]` : '[-]';
    const company = p.companyName.substring(0, COL.company - 1);
    const value = formatCurrency(p.totalValue);
    const insider = `${p.insiderName.substring(0, 22)} (${p.role})`;
    console.log(
      `${(i + 1).toString().padStart(2)}. ` +
        ticker.padEnd(COL.ticker - 4) +
        company.padEnd(COL.company) +
        value.padStart(COL.value) +
        `   ${insider}`,
    );
  });
  console.log(line);

  const payload = buildSlackPayload(purchases, dateRange);

  if (DRY_RUN) {
    console.log('\n📋  Slack payload (dry run):');
    console.log(JSON.stringify(payload, null, 2));
  } else {
    await sendSlackMessage(payload);
    console.log('\n📢  Ranked summary sent to Slack successfully!');
  }
}

main().catch((err: unknown) => {
  console.error('\n❌  Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
