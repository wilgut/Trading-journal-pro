import { NextResponse } from 'next/server'

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

interface InsiderPurchase {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  filedDate: string
  accessionNo: string
}

interface EdgarSearchHit {
  _source: {
    accession_no: string
    entity_name: string
    file_date: string
    period_of_report: string
    [key: string]: unknown
  }
  _id: string
}

// -------------------------------------------------------------------
// EDGAR helpers
// -------------------------------------------------------------------

const EDGAR_HEADERS = {
  'User-Agent': 'TradingJournalPro research@tradingjournal.pro',
  'Accept-Encoding': 'gzip, deflate',
  Accept: 'application/json',
}

/** Returns the last business day (or today if weekday) in YYYY-MM-DD. */
function getBusinessDateRange(): { startDate: string; endDate: string } {
  const now = new Date()
  const day = now.getUTCDay() // 0=Sun, 6=Sat
  const msPerDay = 86_400_000

  // Look back enough to always cover one business day
  const lookbackDays = day === 1 ? 3 : day === 0 ? 2 : 1
  const start = new Date(now.getTime() - lookbackDays * msPerDay)

  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { startDate: fmt(start), endDate: fmt(now) }
}

/** Fetch a page of Form 4 filings from EDGAR full-text search. */
async function fetchFilingList(
  startDate: string,
  endDate: string,
  from = 0,
  size = 40
): Promise<EdgarSearchHit[]> {
  const url =
    `https://efts.sec.gov/LATEST/search-index?forms=4` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
    `&from=${from}&size=${size}`

  const res = await fetch(url, { headers: EDGAR_HEADERS, next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`EDGAR search failed: ${res.status}`)

  const data = await res.json()
  return (data.hits?.hits ?? []) as EdgarSearchHit[]
}

/** Given an accession number and entity hint, resolve the CIK. */
async function resolveCik(accessionNo: string): Promise<string | null> {
  // The accession number leading 10 digits are the filer CIK (zero-padded).
  const stripped = accessionNo.replace(/-/g, '')
  return stripped.slice(0, 10).replace(/^0+/, '')
}

/** Fetch the filing index JSON to find the primary XML document filename. */
async function fetchFilingXmlUrl(cik: string, accessionNo: string): Promise<string | null> {
  const accNoDashes = accessionNo.replace(/-/g, '')
  const indexUrl =
    `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${accessionNo}-index.json`

  const res = await fetch(indexUrl, { headers: EDGAR_HEADERS, next: { revalidate: 0 } })
  if (!res.ok) return null

  const index = await res.json()
  const docs: Array<{ type: string; filename: string; url?: string }> = index.documents ?? []

  // The primary Form 4 XML has document type "4"
  const xmlDoc = docs.find((d) => d.type === '4' && d.filename?.endsWith('.xml'))
  if (!xmlDoc) return null

  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${xmlDoc.filename}`
}

/** Fetch and parse the Form 4 XML, returning purchase transactions. */
async function parseForm4Xml(
  xmlUrl: string,
  accessionNo: string
): Promise<InsiderPurchase[]> {
  const res = await fetch(xmlUrl, { headers: { ...EDGAR_HEADERS, Accept: 'text/xml' }, next: { revalidate: 0 } })
  if (!res.ok) return []

  const xml = await res.text()

  // ---- helpers ----
  const extractTag = (tag: string, source = xml): string => {
    const m = source.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]*)<\\/value>`, 's'))
      ?? source.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/tag>`, 's'))
      ?? source.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, 's'))
    return m ? m[1].trim() : ''
  }

  const ticker = extractTag('issuerTradingSymbol')
  const companyName = extractTag('issuerName')
  const insiderName = extractTag('rptOwnerName')
  const filedDate = extractTag('periodOfReport') || extractTag('dateOfOriginalSubmission') || new Date().toISOString().slice(0, 10)

  // Role: pick the most descriptive title
  const isDirector = extractTag('isDirector') === '1'
  const isOfficer = extractTag('isOfficer') === '1'
  const officerTitle = extractTag('officerTitle')
  const insiderTitle = officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  const results: InsiderPurchase[] = []

  // ---- non-derivative transactions ----
  const nonDerivRegex = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g
  let match: RegExpExecArray | null
  while ((match = nonDerivRegex.exec(xml)) !== null) {
    const block = match[1]

    const txCode = extractTag('transactionCode', block)
    const acqDisp = extractTag('transactionAcquiredDisposedCode', block)

    // P = open-market purchase, A = acquired (not disposed)
    if (txCode !== 'P' || acqDisp !== 'A') continue

    const sharesStr = extractTag('transactionShares', block)
    const priceStr = extractTag('transactionPricePerShare', block)

    const shares = parseFloat(sharesStr)
    const pricePerShare = parseFloat(priceStr)

    if (!shares || !pricePerShare || isNaN(shares) || isNaN(pricePerShare)) continue

    const totalValue = shares * pricePerShare
    if (totalValue < 100_000) continue

    results.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      shares,
      pricePerShare,
      totalValue,
      filedDate,
      accessionNo,
    })
  }

  return results
}

// -------------------------------------------------------------------
// Slack helper
// -------------------------------------------------------------------

function formatSlackMessage(purchases: InsiderPurchase[], dateRange: { startDate: string; endDate: string }): string {
  const fmtUSD = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : `$${(n / 1_000).toFixed(0)}K`

  const fmtShares = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString()

  const medals = ['🥇', '🥈', '🥉']

  const rows = purchases
    .slice(0, 10)
    .map((p, i) => {
      const rank = medals[i] ?? `${i + 1}.`
      const ticker = p.ticker ? ` (\`${p.ticker}\`)` : ''
      return (
        `${rank} **${p.companyName}**${ticker}\n` +
        `   └ ${p.insiderName} · ${p.insiderTitle}\n` +
        `   └ ${fmtShares(p.shares)} shares @ $${p.pricePerShare.toFixed(2)} → **${fmtUSD(p.totalValue)}**`
      )
    })
    .join('\n\n')

  const totalBought = purchases.reduce((s, p) => s + p.totalValue, 0)
  const header =
    `## 🏦 SEC Form 4 Insider Purchase Scanner\n` +
    `**Period:** ${dateRange.startDate} → ${dateRange.endDate}  |  ` +
    `**Qualifying buys (>$100K):** ${purchases.length}  |  ` +
    `**Total capital deployed:** ${fmtUSD(totalBought)}\n\n`

  const footer =
    `\n\n---\n_Source: SEC EDGAR Form 4 · Open-market purchases only (transaction code P) · Ranked by total value_`

  return purchases.length === 0
    ? header + '_No insider purchases exceeding $100K filed in this window._' + footer
    : header + rows + footer
}

async function sendSlackMessage(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('SLACK_WEBHOOK_URL not set — skipping Slack notification')
    return
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status}`)
  }
}

// -------------------------------------------------------------------
// Route handler
// -------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { startDate, endDate } = getBusinessDateRange()

    // Fetch up to 2 pages (80 filings) to maximise coverage
    const [page1, page2] = await Promise.all([
      fetchFilingList(startDate, endDate, 0, 40),
      fetchFilingList(startDate, endDate, 40, 40),
    ])
    const allFilings = [...page1, ...page2]

    if (allFilings.length === 0) {
      const msg = formatSlackMessage([], { startDate, endDate })
      await sendSlackMessage(msg)
      return NextResponse.json({ purchases: [], dateRange: { startDate, endDate } })
    }

    // Process filings with a concurrency cap of 8 to respect EDGAR rate limits
    const CONCURRENCY = 8
    const purchases: InsiderPurchase[] = []

    for (let i = 0; i < allFilings.length; i += CONCURRENCY) {
      const batch = allFilings.slice(i, i + CONCURRENCY)

      const batchResults = await Promise.all(
        batch.map(async (hit) => {
          try {
            const acc = hit._source.accession_no
            const cik = await resolveCik(acc)
            if (!cik) return []

            const xmlUrl = await fetchFilingXmlUrl(cik, acc)
            if (!xmlUrl) return []

            return parseForm4Xml(xmlUrl, acc)
          } catch {
            return []
          }
        })
      )

      batchResults.forEach((list) => purchases.push(...list))
    }

    // Rank by total value descending
    purchases.sort((a, b) => b.totalValue - a.totalValue)

    const slackMsg = formatSlackMessage(purchases, { startDate, endDate })
    await sendSlackMessage(slackMsg)

    return NextResponse.json({
      dateRange: { startDate, endDate },
      totalFilingsChecked: allFilings.length,
      purchases,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
