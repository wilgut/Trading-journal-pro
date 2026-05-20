/**
 * Slack Block-Kit formatter and webhook sender for insider-buy alerts.
 *
 * Requires SLACK_WEBHOOK_URL env variable (Slack incoming-webhook URL).
 * If the variable is absent the helper returns { sent: false } instead
 * of throwing, so a dry-run or misconfigured environment won't crash.
 */

import type { InsiderPurchase } from './edgar';

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';

// ── Formatters ────────────────────────────────────────────────────────────

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)     return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function shares(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function roleLabel(p: InsiderPurchase): string {
  const parts: string[] = [];
  if (p.isOfficer && p.insiderTitle) parts.push(p.insiderTitle);
  else if (p.isOfficer) parts.push('Officer');
  if (p.isDirector) parts.push('Director');
  return parts.join(' · ') || 'Insider';
}

// ── Block-Kit builder ─────────────────────────────────────────────────────

type SlackBlock = Record<string, unknown>;

function buildBlocks(purchases: InsiderPurchase[], reportDate: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `SEC Insider Buys • ${reportDate}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${purchases.length}* open-market insider purchase${purchases.length !== 1 ? 's' : ''} ` +
          `>$100K filed in the last 24 hours, ranked by size.`,
      },
    },
    { type: 'divider' },
  ];

  // Slack recommends ≤50 blocks; cap displayed entries at 15.
  const top = purchases.slice(0, 15);

  for (let i = 0; i < top.length; i++) {
    const p          = top[i];
    const tickerPart = p.ticker ? ` · $${p.ticker}` : '';
    const role       = roleLabel(p);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${i + 1}. ${p.company}${tickerPart}*`,
          `\u{1F464} ${p.insiderName}  (${role})`,
          `\u{1F4C8} ${shares(p.shares)} shares @ $${p.pricePerShare.toFixed(2)}/sh`,
          `\u{1F4B0} *${usd(p.totalValue)}*  ·  Txn: ${p.transactionDate}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'SEC Filing', emoji: false },
        url: p.secUrl,
        action_id: `view_filing_${i}`,
      },
    });

    blocks.push({ type: 'divider' });
  }

  if (purchases.length > 15) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_…and ${purchases.length - 15} more qualifying purchases not shown._`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `Source: <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4>` +
          `  ·  ${purchases.length} qualifying purchase${purchases.length !== 1 ? 's' : ''} found`,
      },
    ],
  });

  return blocks;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface SlackSendResult {
  sent:          boolean;
  purchaseCount: number;
  message?:      string;
}

export async function sendInsiderBuysToSlack(
  purchases: InsiderPurchase[],
): Promise<SlackSendResult> {
  if (!WEBHOOK_URL) {
    return {
      sent:          false,
      purchaseCount: purchases.length,
      message:       'SLACK_WEBHOOK_URL is not configured',
    };
  }

  const reportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  let payload: Record<string, unknown>;

  if (purchases.length === 0) {
    payload = { text: `No insider purchases >$100K found in the last 24 hours (${reportDate}).` };
  } else {
    payload = {
      text:   `${purchases.length} insider buys >$100K • ${reportDate}`, // fallback plain text
      blocks: buildBlocks(purchases, reportDate),
    };
  }

  const res = await fetch(WEBHOOK_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack webhook error ${res.status}: ${body}`);
  }

  return { sent: true, purchaseCount: purchases.length };
}
