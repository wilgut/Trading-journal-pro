import { NextRequest, NextResponse } from 'next/server';
import { getInsiderBuys } from '@/lib/edgar';
import { formatInsiderBuysMessage } from '@/lib/slack-notify';

const DEFAULT_MIN_VALUE = 100_000;
const DEFAULT_WINDOW_HOURS = 24;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const minValue = Number(sp.get('minValue') ?? DEFAULT_MIN_VALUE);
  const windowHours = Number(sp.get('windowHours') ?? DEFAULT_WINDOW_HOURS);

  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  try {
    const buys = await getInsiderBuys({ since, minValueUSD: minValue });
    const message = formatInsiderBuysMessage(buys, minValue, windowHours);

    // Optionally post to Slack if a webhook URL is configured
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    let slackPosted = false;
    if (slackWebhook) {
      const slackRes = await fetch(slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      slackPosted = slackRes.ok;
    }

    return NextResponse.json({ buys, message, slackPosted, count: buys.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
