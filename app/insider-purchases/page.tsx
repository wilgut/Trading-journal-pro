'use client'

import { useState } from 'react'

interface Purchase {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
}

interface ApiResult {
  success: boolean
  dateRange: string
  filingsChecked: number
  purchasesFound: number
  slackSent: boolean
  purchases: Purchase[]
  error?: string
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  return `$${Math.round(n / 1_000)}K`
}

export default function InsiderPurchasesPage() {
  const [result, setResult]   = useState<ApiResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [sendSlack, setSendSlack] = useState(true)

  async function run() {
    setLoading(true)
    setResult(null)
    try {
      const params = sendSlack ? '' : '?skip_slack=true'
      const res  = await fetch(`/api/insider-purchases${params}`)
      const data = await res.json()
      setResult(data)
    } catch (err) {
      setResult({ success: false, error: String(err), dateRange: '', filingsChecked: 0, purchasesFound: 0, slackSent: false, purchases: [] })
    } finally {
      setLoading(false)
    }
  }

  const medals = ['🥇', '🥈', '🥉']

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">SEC Insider Purchase Scanner</h1>
        <p className="text-gray-400 mb-8">
          Scans SEC EDGAR Form 4 filings from the last 24 hours for executive &amp; director
          open-market purchases exceeding $100K.
        </p>

        <div className="flex items-center gap-6 mb-8">
          <button
            onClick={run}
            disabled={loading}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:cursor-not-allowed rounded-lg font-semibold transition-colors"
          >
            {loading ? 'Scanning EDGAR…' : 'Run Scan'}
          </button>

          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sendSlack}
              onChange={e => setSendSlack(e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            Send results to Slack (#all-claude-trading)
          </label>
        </div>

        {loading && (
          <div className="text-blue-400 animate-pulse text-sm">
            Fetching Form 4 filings from EDGAR and parsing XML documents…
          </div>
        )}

        {result && (
          <>
            {result.success ? (
              <>
                <div className="flex gap-6 mb-6 text-sm text-gray-400">
                  <span>Period: <strong className="text-white">{result.dateRange}</strong></span>
                  <span>Filings checked: <strong className="text-white">{result.filingsChecked}</strong></span>
                  <span>Purchases &gt;$100K: <strong className="text-emerald-400">{result.purchasesFound}</strong></span>
                  {result.slackSent && <span className="text-emerald-400">✓ Sent to Slack</span>}
                </div>

                {result.purchases.length === 0 ? (
                  <p className="text-gray-500">No purchases above $100K found in this window.</p>
                ) : (
                  <div className="space-y-3">
                    {result.purchases.slice(0, 30).map((p, i) => (
                      <div
                        key={i}
                        className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start gap-4"
                      >
                        <span className="text-2xl">{medals[i] ?? `${i + 1}`}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-3 flex-wrap">
                            <span className="text-xl font-bold text-emerald-400">
                              {fmt(p.totalValue)}
                            </span>
                            <span className="font-semibold text-white truncate">
                              {p.companyName}
                              {p.ticker && (
                                <span className="ml-2 text-gray-400 text-sm font-normal">
                                  ({p.ticker})
                                </span>
                              )}
                            </span>
                          </div>
                          <p className="text-sm text-gray-300 mt-1">
                            {p.insiderName}{' '}
                            <span className="text-gray-500">({p.insiderTitle})</span>
                            {' · '}
                            {p.shares.toLocaleString()} shares @ ${p.pricePerShare.toFixed(2)}
                            {' · '}
                            {p.transactionDate}
                          </p>
                        </div>
                        <a
                          href={p.filingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
                        >
                          SEC Filing ↗
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-400">
                Error: {result.error}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  )
}
