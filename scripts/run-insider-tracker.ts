#!/usr/bin/env npx ts-node
/**
 * Standalone runner — SEC EDGAR Insider Purchase Tracker
 *
 * Usage:
 *   npx ts-node scripts/run-insider-tracker.ts
 *
 * Required env vars (set in .env or shell):
 *   SEC_USER_AGENT      — "AppName your@email.com"  (SEC requirement)
 *   SLACK_WEBHOOK_URL   — Slack Incoming Webhook URL
 *
 * Optional:
 *   HOURS_BACK          — look-back window in hours (default 24)
 */

import { fetchInsiderPurchases, buildSlackMessage } from "../lib/sec-insider-tracker";

async function sendSlackWebhook(webhookUrl: string, text: string) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}

async function main() {
  const hoursBack = parseInt(process.env.HOURS_BACK ?? "24", 10);

  const purchases = await fetchInsiderPurchases(hoursBack, console.log);

  const asOf = new Date().toUTCString();
  const message = buildSlackMessage(purchases, asOf);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    await sendSlackWebhook(webhookUrl, message);
    console.log("✓ Summary sent to Slack");
  } else {
    console.log("\n──── Slack Message Preview ────\n");
    console.log(message);
    console.log(
      "\n(Set SLACK_WEBHOOK_URL in your environment to post to Slack)"
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
