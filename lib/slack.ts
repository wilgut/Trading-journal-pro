/**
 * Slack Incoming Webhook client for insider-buys notifications.
 *
 * Requires SLACK_WEBHOOK_URL env var (Incoming Webhook from your Slack app).
 */

import type { InsiderPurchase } from "./edgar";

// ─── Public API ──────────────────────────────────────────────────────────────

export async function sendInsiderBuysSummary(
  purchases: InsiderPurchase[],
  webhookUrl: string
): Promise<void> {
  const payload =
    purchases.length === 0
      ? buildEmptyPayload()
      : buildSummaryPayload(purchases);

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
  }
}

// ─── Payload builders ────────────────────────────────────────────────────────

function buildEmptyPayload() {
  return {
    text: "SEC Insider Buys (last 24h): No purchases over $100k found.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":chart_with_upwards_trend: *SEC Insider Buys — Last 24h*\nNo open-market purchases above $100k were filed in this window.",
        },
      },
    ],
  };
}

function buildSummaryPayload(purchases: InsiderPurchase[]) {
  // Slack has a 50-block limit; cap list at 20 entries with dividers
  const top = purchases.slice(0, 20);
  const extra = purchases.length - top.length;

  const header = {
    type: "header",
    text: {
      type: "plain_text",
      text: `SEC Insider Buys — Last 24h (${purchases.length} purchases >$100k)`,
      emoji: true,
    },
  };

  const intro = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `Ranked by purchase value. Source: SEC EDGAR Form 4 filings. ${
        extra > 0 ? `_(+${extra} more not shown)_` : ""
      }`,
    },
  };

  const rows = top.flatMap((p, i) => [
    buildPurchaseBlock(p, i),
    { type: "divider" },
  ]);

  const footer = {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Data as of ${new Date().toUTCString()} | <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40|View all Form 4s on EDGAR>`,
      },
    ],
  };

  return {
    text: `SEC Insider Buys: ${purchases.length} purchases >$100k in last 24h. Top: ${top[0].ownerName} bought ${formatCurrency(top[0].totalValue)} of ${top[0].ticker || top[0].companyName}.`,
    blocks: [header, intro, { type: "divider" }, ...rows, footer],
  };
}

function buildPurchaseBlock(p: InsiderPurchase, rank: number) {
  const medal =
    rank === 0 ? ":first_place_medal:" : rank === 1 ? ":second_place_medal:" : rank === 2 ? ":third_place_medal:" : `*${rank + 1}.*`;

  const tickerDisplay = p.ticker ? ` (${p.ticker})` : "";
  const sharesFormatted = p.shares.toLocaleString("en-US");
  const priceFormatted = formatCurrency(p.pricePerShare);
  const totalFormatted = formatCurrency(p.totalValue);

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `${medal}  *${p.companyName}${tickerDisplay}*`,
        `>:bust_in_silhouette: *${p.ownerName}* — ${p.relationship}`,
        `>:moneybag: Bought *${sharesFormatted} shares* @ ${priceFormatted}/sh = *${totalFormatted}*`,
        `>:calendar: Tx date: ${p.transactionDate}  |  Filed: ${p.filingDate}`,
      ].join("\n"),
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "View Filing", emoji: false },
      url: p.filingUrl,
      action_id: `view_filing_${rank}`,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 10_000 ? 0 : 2,
  }).format(n);
}
