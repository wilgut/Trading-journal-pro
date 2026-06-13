import { NextRequest, NextResponse } from 'next/server';
import {
  formatDate,
  gatherInsiderPurchases,
  buildSlackPayload,
  buildEmptySlackPayload,
  sendSlackMessage,
  type InsiderPurchase,
  type TrackerStats,
} from '@/lib/insider-tracker';

// Extend the Vercel/Next.js function timeout for serverless deployments.
// Hobby plan max is 60 s; Pro plan allows up to 300 s.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Optional API-key guard (set INSIDER_API_KEY env var to enable).
  const apiKey = req.nextUrl.searchParams.get('key');
  if (process.env['INSIDER_API_KEY'] && apiKey !== process.env['INSIDER_API_KEY']) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get('dry_run') === '1';

  // Keep API route fast by capping filings at 100 (full 500-filing scan via CLI script).
  const MAX_FILINGS = parseInt(process.env['INSIDER_MAX_FILINGS'] ?? '100', 10);

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = formatDate(yesterday);
  const endDate = formatDate(now);
  const dateRange = `${startDate} → ${endDate}`;

  const stats: TrackerStats = {
    filingsFound: 0,
    filingsProcessed: 0,
    purchasesOver100k: 0,
    totalValue: 0,
  };

  let purchases: InsiderPurchase[];

  try {
    purchases = await gatherInsiderPurchases(startDate, endDate, {
      maxFilings: MAX_FILINGS,
      stats,
    });
  } catch (err) {
    console.error('[insider-purchases] gather error:', err);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }

  if (!dryRun) {
    try {
      const payload =
        purchases.length > 0
          ? buildSlackPayload(purchases, dateRange)
          : buildEmptySlackPayload(dateRange);
      await sendSlackMessage(payload);
    } catch (err) {
      console.error('[insider-purchases] Slack error:', err);
      return NextResponse.json(
        {
          ok: false,
          error: `Slack delivery failed: ${(err as Error).message}`,
          stats,
          topPurchases: purchases.slice(0, 5),
        },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    dateRange,
    stats,
    topPurchases: purchases.slice(0, 20).map((p) => ({
      ticker: p.ticker,
      companyName: p.companyName,
      insiderName: p.insiderName,
      role: p.role,
      shares: p.shares,
      pricePerShare: p.pricePerShare,
      totalValue: p.totalValue,
      transactionDate: p.transactionDate,
      edgarUrl: p.edgarUrl,
    })),
  });
}
