/**
 * GET /api/insider-buys
 *
 * Fetches SEC EDGAR Form 4 filings from the last 24 hours, finds every
 * executive / director open-market purchase over $100k, ranks them by
 * total value, and sends a summary to Slack.
 *
 * Security: Requires a Bearer token matching the API_SECRET_KEY env var
 * (skip the check if the env var is not set, e.g. during local dev).
 *
 * Env vars:
 *   SLACK_WEBHOOK_URL   — Slack Incoming Webhook URL (required)
 *   API_SECRET_KEY      — Optional Bearer token to protect this endpoint
 *   MIN_PURCHASE_VALUE  — Minimum $ value to include (default: 100000)
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchInsiderPurchases } from "@/lib/edgar";
import { sendInsiderBuysSummary } from "@/lib/slack";

export const dynamic = "force-dynamic"; // never cache this route

export async function GET(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const secretKey = process.env.API_SECRET_KEY;
  if (secretKey) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== secretKey) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json(
      { error: "SLACK_WEBHOOK_URL environment variable is not configured." },
      { status: 500 }
    );
  }

  const minValue = parseInt(
    process.env.MIN_PURCHASE_VALUE ?? "100000",
    10
  );

  // ── Fetch & filter ───────────────────────────────────────────────────────
  let purchases;
  try {
    purchases = await fetchInsiderPurchases(minValue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `EDGAR fetch failed: ${message}` },
      { status: 502 }
    );
  }

  // ── Notify Slack ─────────────────────────────────────────────────────────
  try {
    await sendInsiderBuysSummary(purchases, webhookUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Slack notification failed: ${message}` },
      { status: 502 }
    );
  }

  // ── Respond ──────────────────────────────────────────────────────────────
  return NextResponse.json({
    success: true,
    purchasesFound: purchases.length,
    minValueFilter: minValue,
    topPurchases: purchases.slice(0, 10).map((p) => ({
      company: p.companyName,
      ticker: p.ticker,
      insider: p.ownerName,
      role: p.relationship,
      shares: p.shares,
      pricePerShare: p.pricePerShare,
      totalValue: p.totalValue,
      txDate: p.transactionDate,
      filedDate: p.filingDate,
    })),
  });
}
