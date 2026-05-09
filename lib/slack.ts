import type { InsiderTrade } from './edgar';

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string } }
  | { type: 'divider' }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } };

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function formatShares(shares: number): string {
  return shares.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function buildSlackMessage(trades: InsiderTrade[]): {
  text: string;
  blocks: SlackBlock[];
} {
  const timestamp = new Date().toUTCString();
  const top = trades.slice(0, 10);
  const totalBuying = trades.reduce((sum, t) => sum + t.totalValue, 0);

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Insider Purchases >$100k — Last 24 Hours',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${timestamp}* | Source: SEC EDGAR Form 4 | ${trades.length} qualifying transaction${trades.length !== 1 ? 's' : ''}`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (top.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_No insider purchases above $100k filed in the last 24 hours._',
      },
    });
  } else {
    top.forEach((trade, idx) => {
      const label = trade.ticker || trade.companyName;
      const priceFormatted = `$${trade.pricePerShare.toFixed(2)}`;
      const valueFormatted = formatCurrency(trade.totalValue);
      const sharesFormatted = formatShares(trade.shares);

      const line1 = `*${idx + 1}. <${trade.edgarUrl}|${label}>* — ${trade.companyName}`;
      const line2 = `${trade.insiderName} | _${trade.insiderTitle}_`;
      const line3 = `Bought *${sharesFormatted} shares* @ ${priceFormatted} = *${valueFormatted}*`;
      const line4 = `Filed: ${trade.filingDate}${trade.transactionDate ? ` | Txn: ${trade.transactionDate}` : ''}`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [line1, line2, line3, line4].join('\n'),
        },
      });
    });

    if (trades.length > 10) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_...and ${trades.length - 10} more transaction${trades.length - 10 !== 1 ? 's' : ''} not shown_`,
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
          text: `*Total insider buying shown: ${formatCurrency(top.reduce((s, t) => s + t.totalValue, 0))}* | All transactions: ${formatCurrency(totalBuying)}`,
        },
      ],
    });
  }

  const fallbackText =
    top.length === 0
      ? 'No insider purchases >$100k in the last 24 hours.'
      : `Top insider purchase: ${top[0].insiderName} bought ${formatCurrency(top[0].totalValue)} of ${top[0].ticker || top[0].companyName}`;

  return { text: fallbackText, blocks };
}

export async function sendInsiderTradesSummary(
  trades: InsiderTrade[],
  webhookUrl: string
): Promise<void> {
  const payload = buildSlackMessage(trades);

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} ${body}`);
  }
}
