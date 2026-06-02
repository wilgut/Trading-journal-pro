#!/usr/bin/env npx tsx
/**
 * Standalone script — run manually or from any CI / scheduler:
 *
 *   npx tsx scripts/check-insider-buys.ts
 *   MIN_VALUE=250000 HOURS_BACK=48 npx tsx scripts/check-insider-buys.ts
 *
 * Env vars:
 *   SLACK_WEBHOOK_URL  — required to post to Slack
 *   SEC_USER_AGENT     — optional override for SEC request User-Agent
 *   MIN_VALUE          — minimum purchase value in USD (default 100000)
 *   HOURS_BACK         — look-back window in hours (default 24)
 */

import { getInsiderBuys } from '../lib/edgar';
import { buildSlackMessage, sendViaWebhook } from '../lib/slack-report';

const MIN_VALUE = Number(process.env.MIN_VALUE ?? 100_000);
const HOURS_BACK = Number(process.env.HOURS_BACK ?? 24);

(async () => {
  console.log(
    `Checking SEC EDGAR Form 4 filings — last ${HOURS_BACK}h, purchases ≥ $${MIN_VALUE.toLocaleString()} …`,
  );

  const buys = await getInsiderBuys(MIN_VALUE, HOURS_BACK);

  const reportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });

  const message = buildSlackMessage(buys, reportDate);
  console.log('\n─── Slack message preview ───────────────────────────────\n');
  console.log(message);
  console.log('\n─────────────────────────────────────────────────────────\n');

  if (buys.length) {
    console.log(`Found ${buys.length} significant purchase(s):`);
    buys.slice(0, 10).forEach((b, i) => {
      const val = b.totalValue >= 1e6
        ? `$${(b.totalValue / 1e6).toFixed(2)}M`
        : `$${(b.totalValue / 1e3).toFixed(0)}K`;
      console.log(`  ${i + 1}. ${val.padEnd(9)} ${b.ticker.padEnd(6)} ${b.insiderName} (${b.insiderTitle})`);
    });
  } else {
    console.log('No purchases meeting the criteria were found.');
  }

  if (process.env.SLACK_WEBHOOK_URL) {
    await sendViaWebhook(message);
    console.log('\nSlack notification sent.');
  } else {
    console.log('\nSet SLACK_WEBHOOK_URL to post to Slack.');
  }
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
