/**
 * GET /api/insider-buys
 *
 * Fetches recent Form 4 filings from SEC EDGAR, filters for open-market
 * purchases > $100K in the last 24 hours, and POSTs a ranked summary to
 * the configured Slack webhook.
 *
 * Intended to be triggered by a daily cron job (see vercel.json).
 * A secret key (CRON_SECRET) guards against unauthorised calls.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInsiderBuys } from '@/lib/edgar';
import { buildSlackMessage, sendViaWebhook } from '@/lib/slack-report';

export const maxDuration = 60; // seconds — Vercel Pro allows up to 300 s

export async function GET(req: NextRequest) {
  // Protect the endpoint so only the cron runner (or an authorised client) can call it
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const minValue = Number(req.nextUrl.searchParams.get('minValue') ?? 100_000);
    const hoursBack = Number(req.nextUrl.searchParams.get('hoursBack') ?? 24);

    const buys = await getInsiderBuys(minValue, hoursBack);
    const reportDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York',
    });

    const message = buildSlackMessage(buys, reportDate);

    if (process.env.SLACK_WEBHOOK_URL) {
      await sendViaWebhook(message);
    }

    return NextResponse.json({
      ok: true,
      purchasesFound: buys.length,
      reportDate,
      // Return the top 5 in the API response for quick inspection
      preview: buys.slice(0, 5).map(b => ({
        ticker: b.ticker,
        company: b.companyName,
        insider: b.insiderName,
        title: b.insiderTitle,
        totalValue: b.totalValue,
        transactionDate: b.transactionDate,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[insider-buys]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
