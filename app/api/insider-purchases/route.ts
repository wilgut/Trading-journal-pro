import { NextResponse } from 'next/server';
import { fetchInsiderPurchases } from '@/lib/sec-edgar';
import { sendInsiderSummary } from '@/lib/slack';

// In-memory cache — survives within a single serverless instance lifetime.
// Good enough for a scheduled cron trigger; use Redis/KV for multi-instance setups.
let cache: { data: Awaited<ReturnType<typeof fetchInsiderPurchases>>; at: number } | null = null;
const CACHE_TTL = 30 * 60_000; // 30 minutes

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minValue = Number(searchParams.get('minValue') ?? 100_000);
  const hoursBack = Number(searchParams.get('hoursBack') ?? 24);
  const skipSlack = searchParams.get('skipSlack') === '1';

  try {
    const now = Date.now();

    if (cache && now - cache.at < CACHE_TTL) {
      return NextResponse.json({ source: 'cache', count: cache.data.length, purchases: cache.data });
    }

    const purchases = await fetchInsiderPurchases(minValue, hoursBack);
    cache = { data: purchases, at: now };

    if (!skipSlack && process.env.SLACK_WEBHOOK_URL) {
      const date = new Date().toISOString().slice(0, 10);
      await sendInsiderSummary(purchases, date).catch(err =>
        console.error('Slack delivery failed:', err)
      );
    }

    return NextResponse.json({ source: 'live', count: purchases.length, purchases });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
