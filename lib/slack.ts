import type { InsiderPurchase } from './sec-edgar';

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';

function fmt$(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function buildSlackBlocks(purchases: InsiderPurchase[], date: string) {
  const top = purchases.slice(0, 10);

  const rows = top.map((p, i) => ({
    type: 'section' as const,
    text: {
      type: 'mrkdwn' as const,
      text: [
        `*${i + 1}. ${p.ticker || '—'} — ${p.companyName}*`,
        `>${p.insiderName}  _(${p.insiderTitle})_`,
        `>Bought *${fmtNum(p.shares)} shares* @ *$${p.pricePerShare.toFixed(2)}*  →  *${fmt$(p.totalValue)}*`,
        `>Txn: ${p.transactionDate}  |  Filed: ${p.filedDate}`,
      ].join('\n'),
    },
    accessory: {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: 'SEC Filing' },
      url: p.secFilingUrl,
    },
  }));

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔔 SEC Insider Purchases — ${date}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          purchases.length === 0
            ? '_No purchases over $100K found in the last 24 hours._'
            : `Found *${purchases.length}* meaningful purchases (>$100K). Showing top ${top.length} by value:`,
      },
    },
    { type: 'divider' },
    ...rows,
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Source: SEC EDGAR Form 4 filings  •  Generated ${new Date().toUTCString()}`,
        },
      ],
    },
  ];
}

export async function sendInsiderSummary(
  purchases: InsiderPurchase[],
  date: string
): Promise<void> {
  if (!WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL is not set');

  const body = JSON.stringify({ blocks: buildSlackBlocks(purchases, date) });
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack webhook error ${res.status}: ${text}`);
  }
}
