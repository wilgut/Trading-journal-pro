// ─────────────────────────────────────────────────────────────────────────────
//  Slack Notifier
//
//  Supports two delivery methods:
//    1. Incoming Webhook URL  (SLACK_WEBHOOK_URL env var)
//    2. Bot Token             (SLACK_BOT_TOKEN + SLACK_CHANNEL env vars)
// ─────────────────────────────────────────────────────────────────────────────

export interface SlackConfig {
  /** Incoming Webhook URL — takes priority if set */
  webhookUrl?: string
  /** Bot token (xoxb-...) — used when no webhook URL is provided */
  botToken?: string
  /** Channel ID or name (e.g. "#trading-alerts" or "C0123456789") */
  channel?: string
}

export async function sendSlackMessage(
  text:    string,
  config?: SlackConfig,
): Promise<void> {
  // Resolve config from env if not passed explicitly
  const webhookUrl = config?.webhookUrl ?? process.env.SLACK_WEBHOOK_URL
  const botToken   = config?.botToken   ?? process.env.SLACK_BOT_TOKEN
  const channel    = config?.channel    ?? process.env.SLACK_CHANNEL ?? '#general'

  if (webhookUrl) {
    await postViaWebhook(text, webhookUrl)
  } else if (botToken) {
    await postViaBotToken(text, botToken, channel)
  } else {
    throw new Error(
      'Slack not configured — set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN in your environment.'
    )
  }
}

// ── Delivery: Incoming Webhook ────────────────────────────────────────────────

async function postViaWebhook(text: string, webhookUrl: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text, mrkdwn: true }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Slack webhook returned ${res.status}: ${body}`)
  }
}

// ── Delivery: Bot Token (chat.postMessage) ────────────────────────────────────

async function postViaBotToken(
  text:    string,
  token:   string,
  channel: string,
): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel,
      text,
      mrkdwn: true,
      unfurl_links: false,
    }),
  })

  const data: { ok: boolean; error?: string } = await res.json()
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`)
  }
}
