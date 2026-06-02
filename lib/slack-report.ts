/**
 * Formats and sends the insider-buys summary to Slack.
 *
 * Supports two delivery modes:
 *   1. Incoming Webhook  — set SLACK_WEBHOOK_URL in env (production / cron)
 *   2. Slack Web API     — pass a channelId at runtime (used by the MCP layer)
 */

import type { InsiderBuy } from './edgar';

const fmt$ = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
    ? `$${(n / 1_000).toFixed(0)}K`
    : `$${n.toFixed(0)}`;

const fmtShares = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

export function buildSlackMessage(buys: InsiderBuy[], reportDate: string): string {
  if (buys.length === 0) {
    return [
      `*SEC Insider Buys — ${reportDate}*`,
      'No significant open-market purchases (>$100K) were filed in the last 24 hours.',
    ].join('\n');
  }

  const totalValue = buys.reduce((s, b) => s + b.totalValue, 0);
  const uniqueCompanies = new Set(buys.map(b => b.ticker)).size;

  const header = [
    `*SEC Insider Buys Alert — ${reportDate}*`,
    `_Open-market purchases >$100K filed in the last 24 hours · ranked by value_`,
    '',
  ].join('\n');

  const rows = buys
    .slice(0, 20) // cap at 20 so the message stays readable
    .map((b, i) => {
      const rank = `*${i + 1}.* ${fmt$(b.totalValue)}`;
      const co = `*${b.companyName}${b.ticker !== 'N/A' ? ` (${b.ticker})` : ''}*`;
      const who = `${b.insiderName} · ${b.insiderTitle}`;
      const detail = `${fmtShares(b.shares)} shares @ $${b.pricePerShare.toFixed(2)} · ${b.transactionDate}`;
      const link = `<${b.filingUrl}|View filing>`;
      return `${rank}\n${co}\n${who}\n${detail} · ${link}`;
    })
    .join('\n\n');

  const footer = [
    '',
    `*${buys.length} purchase${buys.length > 1 ? 's' : ''}* across ${uniqueCompanies} compan${uniqueCompanies > 1 ? 'ies' : 'y'} · ${fmt$(totalValue)} combined`,
    `_Source: SEC EDGAR Form 4 filings_`,
  ].join('\n');

  return header + rows + footer;
}

/** POST to a Slack Incoming Webhook. Throws on non-2xx. */
export async function sendViaWebhook(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL env var is not set');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed ${res.status}: ${body}`);
  }
}
