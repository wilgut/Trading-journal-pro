// ─────────────────────────────────────────────────────────────────────────────
//  Slack Message Formatter for Insider Trades
// ─────────────────────────────────────────────────────────────────────────────

import type { InsiderTrade, PurchaseSummary } from './types'

// ── Currency / number helpers ─────────────────────────────────────────────────

export function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtShares(n: number): string {
  return n.toLocaleString('en-US')
}

// ── Role badge ────────────────────────────────────────────────────────────────

function roleBadge(t: InsiderTrade): string {
  if (t.isDirector && t.isOfficer) return '👔🎯'
  if (t.isDirector)                return '🎯'
  if (t.isOfficer)                 return '👔'
  if (t.isTenPercentOwner)         return '🏦'
  return '👤'
}

// ── Signal strength ───────────────────────────────────────────────────────────

function signalStrength(t: InsiderTrade): string {
  const v = t.totalValue
  if (v >= 10_000_000) return '🔥🔥🔥'
  if (v >= 1_000_000)  return '🔥🔥'
  if (v >= 500_000)    return '🔥'
  return '📌'
}

// ── Single trade row ──────────────────────────────────────────────────────────

export function formatTradeRow(t: InsiderTrade): string {
  const tickerStr = t.ticker ? `\`${t.ticker}\`` : `_${t.companyName}_`
  const signal    = signalStrength(t)
  const badge     = roleBadge(t)

  let row = ''
  row += `*${t.rank}. ${tickerStr}  —  ${fmtMoney(t.totalValue)}* ${signal}\n`
  row += `   ${badge} ${t.insiderName}  ·  ${t.insiderTitle}\n`

  if (t.ticker !== t.companyName) {
    row += `   🏢 ${t.companyName}\n`
  }

  row += `   📈 ${fmtShares(t.shares)} shares @ ${fmtMoney(t.pricePerShare)}/share\n`

  if (t.sharesOwnedAfter > 0) {
    row += `   💼 Holds ${fmtShares(t.sharesOwnedAfter)} shares total after purchase\n`
  }

  row += `   📅 Transacted ${t.transactionDate}  ·  Filed ${t.filingDate}\n`
  row += `   🔗 <${t.filingUrl}|SEC EDGAR Filing>\n`

  return row
}

// ── Full Slack message ────────────────────────────────────────────────────────

/**
 * Build the complete Slack message for an insider-purchases report.
 *
 * Uses Slack's mrkdwn syntax (bold = *text*, italic = _text_, monospace = `code`).
 * Caps the trade list at 20 entries to stay within Slack's 4,000-char limit.
 */
export function buildSlackMessage(summary: PurchaseSummary): string {
  const { trades, totalPurchases, totalValue, hoursBack, minValue, fetchedAt } = summary

  const dateLabel = new Date(fetchedAt).toLocaleDateString('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
    year:    'numeric',
  })

  const minLabel = fmtMoney(minValue)
  const sections: string[] = []

  // ── Header ────────────────────────────────────────────────────────────────
  sections.push(
    `📊 *SEC EDGAR — Significant Insider Purchases*\n` +
    `_${dateLabel}  ·  Last ${hoursBack}h  ·  Min threshold: ${minLabel}_`
  )

  if (trades.length === 0) {
    sections.push(
      `✅ No open-market purchases ≥ ${minLabel} were filed with the SEC in the last ${hoursBack} hours.`
    )
  } else {
    // ── Summary stats ─────────────────────────────────────────────────────
    const topTicker = trades[0].ticker || trades[0].companyName
    sections.push(
      `*${totalPurchases}* qualifying purchases filed  ·  ` +
      `*${fmtMoney(totalValue)}* total bought  ·  ` +
      `Largest: *${topTicker}* (${fmtMoney(trades[0].totalValue)})`
    )

    // ── Divider ───────────────────────────────────────────────────────────
    sections.push('─'.repeat(48))

    // ── Trade rows (top 20) ───────────────────────────────────────────────
    const displayed = trades.slice(0, 20)
    sections.push(displayed.map(formatTradeRow).join('\n'))

    if (trades.length > 20) {
      sections.push(
        `_…and ${trades.length - 20} more purchases not shown. ` +
        `Visit <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40|EDGAR Form 4 search> for the full list._`
      )
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  sections.push(
    `_Source: SEC EDGAR Form 4 filings  ·  Fetched at ${new Date(fetchedAt).toUTCString()}_`
  )

  return sections.join('\n\n')
}

// ── Build summary object ──────────────────────────────────────────────────────

export function buildSummary(
  trades:    InsiderTrade[],
  hoursBack: number,
  minValue:  number,
): PurchaseSummary {
  return {
    trades,
    totalPurchases: trades.length,
    totalValue:     trades.reduce((sum, t) => sum + t.totalValue, 0),
    hoursBack,
    minValue,
    fetchedAt: new Date().toISOString(),
  }
}
