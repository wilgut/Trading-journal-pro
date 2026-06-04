import { NextResponse } from 'next/server';
import {
  runScan,
  buildSlackPayload,
  sendToSlack,
} from '@/lib/sec-edgar/tracker';

/**
 * GET /api/insider-trades
 *
 * Scans EDGAR for insider purchases in the last 24 hours,
 * filters for > $100K, and sends a ranked summary to Slack.
 *
 * Query params:
 *   hours    – look-back window in hours (default: 24)
 *   dryRun   – if "true", returns JSON instead of sending to Slack
 *
 * Required env var: SLACK_WEBHOOK_URL
 *
 * Suitable as a Vercel Cron target:
 *   vercel.json → { "crons": [{ "path": "/api/insider-trades", "schedule": "0 18 * * 1-5" }] }
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hours = parseInt(searchParams.get('hours') ?? '24', 10);
  const dryRun = searchParams.get('dryRun') === 'true';

  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const startDate = from.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  const dateRange = `${startDate} → ${endDate}`;

  const logs: string[] = [];

  try {
    const purchases = await runScan(startDate, endDate, msg => logs.push(msg));

    if (purchases.length === 0) {
      return NextResponse.json({ status: 'ok', message: 'No qualifying purchases found', logs });
    }

    const payload = buildSlackPayload(purchases, dateRange);

    if (dryRun) {
      return NextResponse.json({ status: 'dry_run', purchases, payload, logs });
    }

    await sendToSlack(payload);

    return NextResponse.json({
      status: 'ok',
      purchasesFound: purchases.length,
      dateRange,
      logs,
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: 'error', message: err?.message ?? String(err), logs },
      { status: 500 },
    );
  }
}
