/**
 * Slack notifier for insider-buy summaries.
 *
 * Uses the Slack Web API (chat.postMessage) directly so this module works
 * in any Node.js context (cron job, API route, standalone script).
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN   – xoxb-... bot token with chat:write scope
 *   SLACK_CHANNEL_ID  – target channel ID (e.g. C0ATEAY4P6H)
 */

import type { InsiderBuy } from '../edgar/insider-buys';

const SLACK_API = 'https://slack.com/api/chat.postMessage';

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtShares(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}

function fmtPrice(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function rankEmoji(i: number): string {
  return ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
}

export function formatInsiderBuysSummary(buys: InsiderBuy[], asOfDate: string): string {
  if (buys.length === 0) {
    return (
      `🔔 *Insider Buys > $100K — Last 24h* | ${asOfDate}\n\n` +
      `_No qualifying purchases found in the last 24 hours._`
    );
  }

  const totalVolume = buys.reduce((s, b) => s + b.totalValue, 0);
  const uniqueCos   = new Set(buys.map(b => b.ticker)).size;

  const header =
    `🔔 *Insider Buys > $100K — Last 24h* | ${asOfDate}\n` +
    `📊 **${buys.length} purchases** across **${uniqueCos} companies** — ` +
    `total value **${fmt(totalVolume)}**\n\n`;

  // Table (Slack renders Markdown tables in most clients)
  const tableHeader =
    `| # | Company | Ticker | Insider | Role | Shares | Price | **Total** |\n` +
    `|---|---------|--------|---------|------|-------:|------:|----------:|`;

  const rows = buys
    .slice(0, 25) // cap visible rows to keep the message readable
    .map((b, i) =>
      `| ${rankEmoji(i)} | ${b.companyName} | \`${b.ticker}\` | ${b.insiderName} | ` +
      `${b.insiderTitle} | ${fmtShares(b.shares)} | ${fmtPrice(b.pricePerShare)} | **${fmt(b.totalValue)}** |`,
    )
    .join('\n');

  const footer =
    buys.length > 25
      ? `\n\n_…and ${buys.length - 25} more purchases not shown_\n`
      : '\n';

  return (
    header +
    tableHeader + '\n' +
    rows +
    footer +
    `\n_Source: SEC EDGAR Form 4 filings · Data as of ${asOfDate}_`
  );
}

export async function sendInsiderBuysToSlack(
  buys:       InsiderBuy[],
  asOfDate:   string,
  channelId?: string,
  botToken?:  string,
): Promise<void> {
  const token   = botToken  ?? process.env.SLACK_BOT_TOKEN;
  const channel = channelId ?? process.env.SLACK_CHANNEL_ID;

  if (!token)   throw new Error('SLACK_BOT_TOKEN is not set');
  if (!channel) throw new Error('SLACK_CHANNEL_ID is not set');

  const text = formatInsiderBuysSummary(buys, asOfDate);

  const res = await fetch(SLACK_API, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  });

  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`Slack API error: ${body.error}`);
}
