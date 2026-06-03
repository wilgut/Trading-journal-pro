/**
 * Slack incoming-webhook client for insider-trade alerts.
 *
 * Required env var:
 *   SLACK_WEBHOOK_URL — Slack incoming webhook URL.
 *
 * The message uses Block Kit so it renders nicely in any Slack client.
 * We cap the displayed trades at 20 to stay well under the 50-block limit.
 */

import type { InsiderTransaction } from './edgar';

const MAX_DISPLAYED = 20;

function formatMoney(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatShares(n: number): string {
  return n.toLocaleString('en-US');
}

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string } }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'divider' }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] };

function buildBlocks(
  trades: InsiderTransaction[],
  runAt: string,
): SlackBlock[] {
  const displayed = trades.slice(0, MAX_DISPLAYED);
  const overflow = trades.length > MAX_DISPLAYED ? trades.length - MAX_DISPLAYED : 0;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'SEC Insider Purchases — Last 24 Hours',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          trades.length === 0
            ? '_No qualifying purchases found (>$100,000) in the last 24 hours._'
            : `*${trades.length} qualifying purchase${trades.length !== 1 ? 's' : ''} by executives & directors exceeding $100,000*\nRanked by transaction value`,
      },
    },
    { type: 'divider' },
  ];

  for (const t of displayed) {
    const rankEmoji =
      t.rank === 1 ? '1.' : t.rank === 2 ? '2.' : t.rank === 3 ? '3.' : `${t.rank}.`;
    const label = t.ticker ? `*${t.ticker}*` : `*${t.companyName || 'Unknown'}*`;
    const person = t.filerName
      ? `${t.filerName}${t.relationship ? ` (${t.relationship})` : ''}`
      : t.relationship || 'Insider';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${rankEmoji} ${label} — *${formatMoney(t.totalValue)}*`,
          `${person}`,
          `${formatShares(t.shares)} shares @ $${t.pricePerShare.toFixed(2)}/share`,
          `<${t.filingUrl}|View SEC Filing>`,
        ].join('\n'),
      },
    });
  }

  if (overflow > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${overflow} more purchase${overflow !== 1 ? 's' : ''} not shown._`,
        },
      ],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Source: SEC EDGAR Form 4  |  Run: ${runAt}  |  Not investment advice`,
      },
    ],
  });

  return blocks;
}

export async function sendInsiderAlert(
  trades: InsiderTransaction[],
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL environment variable is not set');
  }

  const runAt = new Date().toUTCString();
  const payload = {
    text: `SEC Insider Purchases — Last 24 Hours (${trades.length} qualifying)`,
    blocks: buildBlocks(trades, runAt),
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack webhook returned ${res.status}: ${body}`);
  }
}
