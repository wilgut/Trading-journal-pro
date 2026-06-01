import type { InsiderPurchase } from './edgar';

function fmt(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
}

function rankEmoji(i: number): string {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return `*${i + 1}.*`;
}

function filingLink(p: InsiderPurchase): string {
  // Link to the company's Form 4 filings on EDGAR
  const cik = String(parseInt(p.accessionNumber.split('-')[0], 10));
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=10`;
}

// Sends the ranked insider purchase summary to a Slack incoming webhook
export async function sendInsiderPurchaseSummary(
  purchases: InsiderPurchase[],
  webhookUrl: string
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceStr = since.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });

  // Slack Block Kit payload
  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔍 SEC Insider Purchases — Last 24 Hours', emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${purchases.length} open-market purchases >$100K* | Since ${sinceStr} | Source: SEC EDGAR Form 4`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (purchases.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_No qualifying insider purchases found in the last 24 hours._',
      },
    });
  } else {
    const top = purchases.slice(0, 10);

    top.forEach((p, i) => {
      const tickerStr = p.ticker ? ` (${p.ticker})` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `${rankEmoji(i)} *${p.companyName}*${tickerStr}`,
            `*${fmt(p.totalValue)}* — ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)}`,
            `👤 ${p.insiderName}${p.insiderTitle ? `  ·  _${p.insiderTitle}_` : ''}`,
            `📅 ${p.transactionDate}`,
          ].join('\n'),
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'View Filing', emoji: false },
          url: filingLink(p),
        },
      });

      if (i < top.length - 1) blocks.push({ type: 'divider' });
    });

    if (purchases.length > 10) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_…and ${purchases.length - 10} more purchases. Check SEC EDGAR for the full list._`,
          },
        ],
      });
    }
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}
