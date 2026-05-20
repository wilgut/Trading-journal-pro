/**
 * GET /api/insider-buys
 *
 * Fetches Form 4 insider purchases from SEC EDGAR for the last 24 hours,
 * filters for meaningful buys (default >$100K), ranks by total value, and
 * posts a summary to Slack.
 *
 * Query params:
 *   minValue   – minimum purchase value in USD (default 100000)
 *   maxFilings – max Form 4 filings to inspect     (default 150)
 *   dryRun     – if "true", skip Slack and return data only
 *
 * This endpoint can be called by a cron job (e.g. Vercel Cron) once a day.
 * It deliberately has a long maxDuration because parsing 100+ EDGAR filings
 * takes time even with batching.
 */

import { NextResponse } from 'next/server';
import { fetchInsiderPurchases } from '@/lib/edgar';
import { sendInsiderBuysToSlack } from '@/lib/slack';

// Allow up to 5 minutes for the EDGAR crawl + Slack send.
export const maxDuration = 300;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const minValue   = Math.max(0, Number(searchParams.get('minValue')   ?? 100_000));
  const maxFilings = Math.max(1, Number(searchParams.get('maxFilings') ?? 150));
  const dryRun     = searchParams.get('dryRun') === 'true';

  try {
    const purchases = await fetchInsiderPurchases({ minValue, maxFilings });

    const slack = dryRun ? null : await sendInsiderBuysToSlack(purchases);

    return NextResponse.json({
      success:       true,
      purchaseCount: purchases.length,
      // Return top 20 in the API response; Slack shows top 15.
      purchases:     purchases.slice(0, 20),
      slack,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[insider-buys]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
