import { NextResponse } from 'next/server';
import { getInsiderBuys }           from '@/lib/edgar/insider-buys';
import { sendInsiderBuysToSlack, formatInsiderBuysSummary } from '@/lib/slack/notifier';

/**
 * GET /api/insider-buys
 *
 * Query params:
 *   minValue   – minimum purchase size in USD (default 100000)
 *   notify     – "true" to also post to Slack (default false)
 *   preview    – "true" to return the formatted Slack message as plain text
 *
 * Intended to be called by a cron scheduler (e.g. Vercel Cron, GitHub Actions)
 * once per day. Protect with CRON_SECRET if exposed publicly.
 */
export async function GET(req: Request) {
  // Optional lightweight auth: check ?secret=... or Authorization header
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const { searchParams } = new URL(req.url);
    const provided =
      searchParams.get('secret') ??
      req.headers.get('Authorization')?.replace('Bearer ', '');
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(req.url);
  const minValue = Number(searchParams.get('minValue') ?? 100_000);
  const notify   = searchParams.get('notify') === 'true';
  const preview  = searchParams.get('preview') === 'true';

  try {
    const buys    = await getInsiderBuys(minValue);
    const asOfDate = new Date().toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });

    if (notify) {
      await sendInsiderBuysToSlack(buys, asOfDate);
    }

    if (preview) {
      return new Response(formatInsiderBuysSummary(buys, asOfDate), {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json({
      asOf:          asOfDate,
      count:         buys.length,
      totalValueUsd: buys.reduce((s, b) => s + b.totalValue, 0),
      notified:      notify,
      buys,
    });
  } catch (err) {
    console.error('[insider-buys]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
