import { NextResponse } from 'next/server';
import { getInsiderPurchases } from '@/lib/edgar';
import { sendInsiderPurchaseSummary } from '@/lib/slack';

export const dynamic = 'force-dynamic'; // never cache — data must be fresh

/**
 * GET /api/insider-purchases
 *
 * Query params:
 *   hours     – look-back window in hours (default: 24)
 *   minValue  – minimum transaction value in USD (default: 100000)
 *   dryRun    – if "true", returns data without posting to Slack
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL – Slack incoming webhook URL
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hours = Math.max(1, Math.min(72, parseInt(searchParams.get('hours') ?? '24', 10)));
  const minValue = Math.max(0, parseInt(searchParams.get('minValue') ?? '100000', 10));
  const dryRun = searchParams.get('dryRun') === 'true';

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!dryRun && !webhookUrl) {
    return NextResponse.json(
      { error: 'SLACK_WEBHOOK_URL environment variable is not set' },
      { status: 500 }
    );
  }

  try {
    const purchases = await getInsiderPurchases(hours, minValue);

    if (!dryRun && webhookUrl) {
      await sendInsiderPurchaseSummary(purchases, webhookUrl);
    }

    return NextResponse.json({
      success: true,
      dryRun,
      count: purchases.length,
      minValue,
      hours,
      purchases: purchases.map(p => ({
        rank: purchases.indexOf(p) + 1,
        company: p.companyName,
        ticker: p.ticker,
        insider: p.insiderName,
        title: p.insiderTitle,
        shares: p.shares,
        pricePerShare: p.pricePerShare,
        totalValue: p.totalValue,
        transactionDate: p.transactionDate,
        filingDate: p.filingDate,
        accessionNumber: p.accessionNumber,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[insider-purchases]', message);
    return NextResponse.json({ error: 'Failed to fetch insider purchases', detail: message }, { status: 500 });
  }
}
