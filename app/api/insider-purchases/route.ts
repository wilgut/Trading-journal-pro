import { NextResponse } from 'next/server'
import { fetchInsiderPurchases, InsiderPurchase, MIN_PURCHASE_VALUE } from '@/lib/edgar/form4'

const $fmt = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${(n / 1_000).toFixed(0)}K`

function buildSlackBlocks(purchases: InsiderPurchase[], since: Date, hours: number) {
  const dateWindow = `${since.toISOString().slice(0, 10)} → ${new Date().toISOString().slice(0, 10)}`
  const threshold  = `$${(MIN_PURCHASE_VALUE / 1_000).toFixed(0)}K`

  const header =
    `*📊 SEC EDGAR Insider Buys >${threshold} — Last ${hours}h*\n` +
    `_${dateWindow} | ${purchases.length} qualifying purchase${purchases.length !== 1 ? 's' : ''}, ranked by total value_`

  if (purchases.length === 0) {
    return `${header}\n\n_No qualifying open-market purchases found in this window._`
  }

  const rows = purchases.slice(0, 20).map(p => {
    const ticker = p.issuerTicker ? ` (${p.issuerTicker})` : ''
    const title  = p.officerTitle ? ` | ${p.officerTitle}` : ''
    return [
      `*${p.rank}.* *${p.issuerName}${ticker}* — ${$fmt(p.totalValue)}`,
      `   ${p.filerName}${title}`,
      `   ${p.shares.toLocaleString()} sh @ $${p.pricePerShare.toFixed(2)} | Filed: ${p.filingDate} | Tx: ${p.transactionDate}`,
    ].join('\n')
  })

  return `${header}\n\n${rows.join('\n\n')}`
}

// GET /api/insider-purchases?hours=24
// Returns the ranked list as JSON + a pre-formatted Slack message string.
// To send directly to Slack, add ?slackWebhook=<url> or configure SLACK_WEBHOOK_URL env var.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const hours   = Math.min(Math.max(Number(searchParams.get('hours') || 24), 1), 168)
  const since   = new Date(Date.now() - hours * 3_600_000)
  const webhook = searchParams.get('slackWebhook') || process.env.SLACK_WEBHOOK_URL

  try {
    const purchases = await fetchInsiderPurchases(hours)
    const message   = buildSlackBlocks(purchases, since, hours)

    if (webhook) {
      const slackRes = await fetch(webhook, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: message }),
      })
      if (!slackRes.ok) {
        console.error('Slack webhook failed:', await slackRes.text())
      }
    }

    return NextResponse.json({
      since:     since.toISOString(),
      asOf:      new Date().toISOString(),
      hours,
      count:     purchases.length,
      purchases,
      slackSent: !!webhook,
      message,
    })
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: detail }, { status: 502 })
  }
}
