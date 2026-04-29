#!/usr/bin/env npx tsx
/**
 * Standalone runner: fetch SEC EDGAR Form 4 insider purchases from the last 24 h,
 * filter for >$100k, and post a ranked summary to the configured Slack channel.
 *
 * Usage:
 *   npx tsx scripts/check-insider-buys.ts [--min <USD>] [--hours <N>] [--dry-run]
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN   - Slack bot token (xoxb-…)
 *   SLACK_CHANNEL_ID  - Slack channel to post to (defaults to sec-form4-insider-scanner)
 *   SLACK_WEBHOOK_URL - Alternative: incoming webhook URL
 */

import { getInsiderBuys } from '../lib/edgar';
import { formatInsiderBuysMessage } from '../lib/slack-notify';

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
  };
  return {
    minValue: Number(get('--min', '100000')),
    windowHours: Number(get('--hours', '24')),
    dryRun: args.includes('--dry-run'),
  };
}

// ── Slack posting ─────────────────────────────────────────────────────────────

async function postToSlack(message: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log('\n── Slack message (dry-run) ─────────────────────────\n');
    console.log(message);
    return;
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND';

  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
    console.log('Posted via Slack webhook.');
    return;
  }

  if (botToken) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: channelId, text: message, mrkdwn: true }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    console.log(`Posted to channel ${channelId}. ts=${data.ts}`);
    return;
  }

  console.warn('No SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN set — printing message to stdout.');
  console.log(message);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { minValue, windowHours, dryRun } = parseArgs();
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  console.log(`Fetching EDGAR Form 4 filings since ${since.toISOString()} (min: $${minValue.toLocaleString()})…`);

  const buys = await getInsiderBuys({ since, minValueUSD: minValue });

  console.log(`Found ${buys.length} qualifying purchase(s).`);
  if (buys.length > 0) {
    console.log('Top 5:');
    buys.slice(0, 5).forEach((b, i) => {
      console.log(
        `  ${i + 1}. ${b.ticker || '???'} — ${b.insiderName} — $${b.totalValue.toLocaleString()}`,
      );
    });
  }

  const message = formatInsiderBuysMessage(buys, minValue, windowHours);
  await postToSlack(message, dryRun);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
