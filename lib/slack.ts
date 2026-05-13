/**
 * Slack incoming-webhook client for the insider-purchase alert.
 *
 * Set SLACK_WEBHOOK_URL in your environment to enable posting.
 * Block Kit reference: https://api.slack.com/block-kit
 */

import type { InsiderPurchase } from './edgar';

function formatDollar(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatDate(dateStr: string): string {
  // dateStr is YYYY-MM-DD; append T12:00:00 to avoid timezone-shift to prior day
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function buildBlocks(
  purchases: InsiderPurchase[],
  minValue: number,
): object[] {
  const shown = purchases.slice(0, 15);

  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ':chart_with_upwards_trend: SEC Insider Purchases — Last 24h',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${purchases.length} qualifying purchase${purchases.length !== 1 ? 's' : ''}* ` +
          `by executives & directors (>${formatDollar(minValue)} threshold)\n` +
          `Showing top ${Math.min(15, purchases.length)} by value:`,
      },
    },
    { type: 'divider' },
  ];

  shown.forEach((p, i) => {
    const role = p.isOfficer && p.insiderTitle ? p.insiderTitle : 'Director';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${i + 1}. ${p.company}${p.ticker ? ` (${p.ticker})` : ''}* — *${formatDollar(p.totalValue)}*`,
          `${p.insiderName}  •  ${role}`,
          `${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)}`,
          `:calendar: ${formatDate(p.transactionDate)}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'SEC Filing', emoji: false },
        url: p.filingUrl,
        action_id: `insider_filing_${i}`,
      },
    });
  });

  if (purchases.length > 15) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_… and ${purchases.length - 15} more qualifying purchases not shown_`,
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
        text: `:information_source: Source: SEC EDGAR Form 4 filings  |  Generated ${new Date().toUTCString()}`,
      },
    ],
  });

  return blocks;
}

export async function sendInsiderAlertsToSlack(
  purchases: InsiderPurchase[],
  minValue = 100_000,
  webhookUrl?: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
  if (!url) return { ok: false, error: 'SLACK_WEBHOOK_URL is not configured' };

  let payload: object;

  if (purchases.length === 0) {
    payload = {
      text: ':chart_with_upwards_trend: *SEC Insider Purchase Alert* — No qualifying purchases found in the last 24 hours.',
    };
  } else {
    payload = {
      text: `:chart_with_upwards_trend: SEC Insider Purchases Alert — ${purchases.length} purchases >${formatDollar(minValue)} in last 24h`,
      blocks: buildBlocks(purchases, minValue),
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return { ok: false, error: text };
  }

  return { ok: true };
}
