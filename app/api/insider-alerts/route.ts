/**
 * /api/insider-alerts
 *
 * GET  — Fetch and return qualifying purchases as JSON (no Slack post).
 *         Useful for previewing or wiring up a dashboard widget.
 *         ?minValue=100000  (default $100 000)
 *
 * POST — Fetch purchases AND send the ranked summary to Slack.
 *         Returns a JSON result with a preview of the top 5 and Slack status.
 *
 * Trigger via a cron job (e.g. Vercel Cron, GitHub Actions schedule) to run
 * daily and keep the team informed of meaningful insider buying activity.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInsiderPurchases } from '@/lib/edgar';
import { sendInsiderAlertsToSlack } from '@/lib/slack';

// Vercel / edge-runtime: allow up to 60 s for this long-running scan
export const maxDuration = 60;

function parseMinValue(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get('minValue');
  const parsed = raw ? Number(raw) : NaN;
  return isNaN(parsed) || parsed < 0 ? 100_000 : parsed;
}

export async function GET(req: NextRequest) {
  const minValue = parseMinValue(req);

  try {
    const purchases = await getInsiderPurchases(minValue);
    return NextResponse.json({ count: purchases.length, purchases });
  } catch (err) {
    console.error('[insider-alerts GET]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const minValue = parseMinValue(req);

  try {
    const purchases = await getInsiderPurchases(minValue);
    const slack = await sendInsiderAlertsToSlack(purchases, minValue);

    return NextResponse.json({
      totalCount: purchases.length,
      topPurchases: purchases.slice(0, 5),
      slack,
    });
  } catch (err) {
    console.error('[insider-alerts POST]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 },
    );
  }
}
