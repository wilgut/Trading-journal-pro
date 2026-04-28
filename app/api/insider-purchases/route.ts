import { NextResponse } from "next/server";
import { scanInsiderPurchases, buildSlackMessage } from "@/lib/edgar/form4";

/**
 * GET /api/insider-purchases?hours=24
 *
 * Scans SEC EDGAR Form 4 filings for insider open-market purchases (code "P")
 * by officers and directors over the last `hours` hours, filtered to ≥$100k.
 *
 * Returns ranked JSON. If SLACK_WEBHOOK_URL is set, also posts to Slack.
 *
 * EDGAR blocks cloud/datacenter IPs — run from a residential or
 * corporate network, or self-host on a non-cloud server.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const hours = Math.min(Number(searchParams.get("hours") ?? 24), 168); // cap at 7 days

  try {
    const result = await scanInsiderPurchases(hours);
    const slackMsg = buildSlackMessage(result);

    // Post to Slack if a webhook URL is configured
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    let slackStatus: "sent" | "skipped" | "error" = "skipped";

    if (webhookUrl) {
      try {
        const slackRes = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: slackMsg }),
        });
        slackStatus = slackRes.ok ? "sent" : "error";
      } catch {
        slackStatus = "error";
      }
    }

    return NextResponse.json({
      ...result,
      slackMessagePreview: slackMsg,
      slackStatus,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Surface EDGAR 403 clearly so operators know it is an IP issue, not a bug
    if (message.includes("403")) {
      return NextResponse.json(
        {
          error:
            "EDGAR returned HTTP 403 — this IP range is blocked. " +
            "Run from a residential or non-cloud server.",
          detail: message,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
