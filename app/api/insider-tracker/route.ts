import { NextResponse } from "next/server";
import {
  fetchInsiderPurchases,
  buildSlackMessage,
} from "../../../lib/sec-insider-tracker";

/**
 * GET /api/insider-tracker
 *
 * Query params:
 *   hours   — look-back window in hours (default 24)
 *   slack   — "true" to also post to SLACK_WEBHOOK_URL
 *
 * Returns JSON with the ranked purchase list and the pre-formatted Slack message.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const hoursBack = parseInt(searchParams.get("hours") ?? "24", 10);
  const postToSlack = searchParams.get("slack") === "true";

  const logs: string[] = [];

  try {
    const purchases = await fetchInsiderPurchases(hoursBack, (msg) => {
      logs.push(msg);
    });

    const asOf = new Date().toUTCString();
    const slackMessage = buildSlackMessage(purchases, asOf);

    if (postToSlack) {
      const webhookUrl = process.env.SLACK_WEBHOOK_URL;
      if (!webhookUrl) {
        return NextResponse.json(
          { error: "SLACK_WEBHOOK_URL is not configured" },
          { status: 500 }
        );
      }
      const slackRes = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: slackMessage }),
      });
      if (!slackRes.ok) {
        return NextResponse.json(
          { error: `Slack webhook returned ${slackRes.status}` },
          { status: 502 }
        );
      }
    }

    return NextResponse.json({
      asOf,
      hoursBack,
      totalFound: purchases.length,
      purchases,
      slackMessage,
      logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, logs }, { status: 500 });
  }
}
