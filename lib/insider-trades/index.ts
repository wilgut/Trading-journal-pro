// ─────────────────────────────────────────────────────────────────────────────
//  Insider Trades — Public API
//
//  Usage:
//    import { runInsiderTradesReport } from '@/lib/insider-trades'
//    const report = await runInsiderTradesReport()
// ─────────────────────────────────────────────────────────────────────────────

export { getSignificantInsiderPurchases } from './edgar'
export { buildSlackMessage, buildSummary, fmtMoney, fmtShares } from './formatter'
export { sendSlackMessage } from './slack'
export type { InsiderTrade, FilingMeta, PurchaseSummary } from './types'

import { getSignificantInsiderPurchases } from './edgar'
import { buildSummary, buildSlackMessage } from './formatter'
import { sendSlackMessage, type SlackConfig } from './slack'
import type { PurchaseSummary } from './types'

export interface RunOptions {
  /** Look-back window in hours (default: 24) */
  hoursBack?: number
  /** Minimum purchase value in USD (default: $100,000) */
  minValue?: number
  /** Send result to Slack (default: true) */
  notify?: boolean
  /** Slack configuration (falls back to env vars) */
  slack?: SlackConfig
}

/**
 * Full pipeline: fetch → parse → filter → rank → (notify).
 *
 * @returns PurchaseSummary with ranked trades and aggregate stats
 */
export async function runInsiderTradesReport(opts: RunOptions = {}): Promise<PurchaseSummary> {
  const {
    hoursBack = 24,
    minValue  = 100_000,
    notify    = true,
    slack,
  } = opts

  const trades = await getSignificantInsiderPurchases(hoursBack, minValue)
  const summary = buildSummary(trades, hoursBack, minValue)

  if (notify) {
    const message = buildSlackMessage(summary)
    await sendSlackMessage(message, slack)
  }

  return summary
}
