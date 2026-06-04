#!/usr/bin/env node
/**
 * SEC EDGAR Insider Purchase Tracker — CLI entry point
 *
 * Scans the last 24 hours of Form 4 filings on SEC EDGAR,
 * filters for open-market purchases > $100K, and sends a
 * ranked summary to Slack.
 *
 * Usage:
 *   npx tsx scripts/sec-insider-tracker.ts
 *
 * Required environment variables:
 *   SLACK_WEBHOOK_URL   – Slack incoming webhook URL
 *
 * Optional environment variables:
 *   EDGAR_USER_AGENT    – "CompanyName your@email.com"  (EDGAR policy requires contact info)
 *   LOOKBACK_HOURS      – Hours to look back (default: 24)
 *   MIN_PURCHASE_USD    – Minimum purchase value in USD (default: 100000)
 */

import {
  runScan,
  buildSlackPayload,
  sendToSlack,
  MIN_PURCHASE_VALUE,
} from '../lib/sec-edgar/tracker';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function printTable(purchases: ReturnType<typeof Array<any>>): void {
  const separator = '─'.repeat(90);
  console.log(separator);
  console.log(
    'Rank  Ticker   Insider                          Role               Value        Shares @ Price',
  );
  console.log(separator);
  purchases
    .sort((a: any, b: any) => b.value - a.value)
    .forEach((p: any, i: number) => {
      const rank = String(i + 1).padStart(4);
      const ticker = (p.ticker || p.company).padEnd(8).slice(0, 8);
      const name = p.insiderName.padEnd(32).slice(0, 32);
      const role = p.role.padEnd(18).slice(0, 18);
      const value =
        p.value >= 1_000_000
          ? `$${(p.value / 1_000_000).toFixed(2)}M`
          : `$${Math.round(p.value / 1_000)}K`;
      const detail = `${p.shares.toLocaleString()} @ $${p.pricePerShare.toFixed(2)}`;
      console.log(`${rank}  ${ticker} ${name} ${role} ${value.padStart(12)}  ${detail}`);
    });
  console.log(separator);
}

async function main(): Promise<void> {
  const lookbackHours = parseInt(process.env.LOOKBACK_HOURS ?? '24', 10);
  const minValue = parseInt(process.env.MIN_PURCHASE_USD ?? String(MIN_PURCHASE_VALUE), 10);

  const now = new Date();
  const from = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const startDate = isoDate(from);
  const endDate = isoDate(now);
  const dateRange = `${startDate} → ${endDate}`;

  console.log('\n📋 SEC EDGAR Insider Purchase Tracker');
  console.log(`   Window  : last ${lookbackHours}h  (${dateRange})`);
  console.log(`   Filter  : open-market purchases (code P) > $${minValue.toLocaleString()}\n`);

  const purchases = await runScan(startDate, endDate, msg => console.log(msg));

  if (purchases.length === 0) {
    console.log('\nNo qualifying insider purchases found in this window.');
    return;
  }

  console.log(`\n✓ ${purchases.length} purchases qualify (>${minValue.toLocaleString()})\n`);
  printTable(purchases);

  const payload = buildSlackPayload(purchases, dateRange);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log(
      '\n⚠  SLACK_WEBHOOK_URL is not set — skipping Slack delivery.\n' +
        '   Set it to send the summary automatically.\n',
    );
    return;
  }

  await sendToSlack(payload);
  console.log('\n✓ Summary sent to Slack.');
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message ?? err);
  process.exit(1);
});
