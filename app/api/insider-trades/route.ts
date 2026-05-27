// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/insider-trades
//
//  Query parameters:
//    hours     — look-back window in hours   (default: 24)
//    min       — minimum purchase value USD  (default: 100000)
//    notify    — "true" to send Slack DM     (default: false)
//    channel   — Slack channel override      (default: env SLACK_CHANNEL)
//
//  Examples:
//    GET /api/insider-trades
//    GET /api/insider-trades?hours=48&min=500000
//    GET /api/insider-trades?notify=true
//
//  Vercel Cron (vercel.json):
//    {"path": "/api/insider-trades?notify=true", "schedule": "0 6 * * 1-5"}
//    → Runs weekday mornings at 06:00 UTC, posts to Slack automatically
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { runInsiderTradesReport, buildSlackMessage } from '@/lib/insider-trades'

export const maxDuration = 300 // Allow up to 5 min for large batches (Vercel Pro)

export async function GET(req: NextRequest) {
  try {
    const sp         = req.nextUrl.searchParams
    const hoursBack  = clamp(Number(sp.get('hours')  ?? 24),   1, 168) // max 1 week
    const minValue   = clamp(Number(sp.get('min')    ?? 100_000), 0, 100_000_000)
    const notify     = sp.get('notify') === 'true'
    const channel    = sp.get('channel') ?? undefined

    const summary = await runInsiderTradesReport({
      hoursBack,
      minValue,
      notify,
      slack: channel ? { channel } : undefined,
    })

    // Return JSON for API consumers; include pre-rendered Slack message too
    return NextResponse.json({
      ok:             true,
      fetchedAt:      summary.fetchedAt,
      hoursBack,
      minValue,
      totalPurchases: summary.totalPurchases,
      totalValue:     summary.totalValue,
      notified:       notify,
      slackPreview:   buildSlackMessage(summary),
      trades:         summary.trades,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[insider-trades]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}
