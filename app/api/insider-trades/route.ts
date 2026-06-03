/**
 * GET  /api/insider-trades          — returns insider purchases as JSON
 * POST /api/insider-trades          — fetches purchases and posts to Slack
 *
 * Query params (both methods):
 *   minValue  — minimum purchase value in USD (default: 100000)
 *   maxFilings — max Form 4 filings to scan (default: 200)
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL      — required for POST
 *   EDGAR_CONTACT_EMAIL    — optional; included in SEC User-Agent header
 */

import { NextResponse } from 'next/server';
import { getRecentInsiderPurchases } from '@/lib/edgar';
import { sendInsiderAlert } from '@/lib/slack';

// Allow up to 5 minutes for Vercel/serverless deployments.
export const maxDuration = 300;

function parseParams(req: Request): { minValue: number; maxFilings: number } {
  const { searchParams } = new URL(req.url);
  const minValue = Math.max(0, Number(searchParams.get('minValue') ?? 100_000));
  const maxFilings = Math.min(
    500,
    Math.max(1, Number(searchParams.get('maxFilings') ?? 200)),
  );
  return { minValue, maxFilings };
}

export async function GET(req: Request) {
  const { minValue, maxFilings } = parseParams(req);

  try {
    const trades = await getRecentInsiderPurchases(minValue, maxFilings);
    return NextResponse.json({
      count: trades.length,
      minValue,
      scannedUpTo: maxFilings,
      generatedAt: new Date().toISOString(),
      trades,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { minValue, maxFilings } = parseParams(req);

  if (!process.env.SLACK_WEBHOOK_URL) {
    return NextResponse.json(
      { error: 'SLACK_WEBHOOK_URL is not configured' },
      { status: 500 },
    );
  }

  try {
    const trades = await getRecentInsiderPurchases(minValue, maxFilings);
    await sendInsiderAlert(trades);

    return NextResponse.json({
      ok: true,
      sentToSlack: true,
      count: trades.length,
      minValue,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
