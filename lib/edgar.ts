/**
 * SEC EDGAR Form 4 parser — fetches insider purchases from the last N hours,
 * filters by minimum dollar value, and returns a ranked list.
 *
 * EDGAR requires every automated request to include a User-Agent header in the
 * format:  "Company/App Name contact@email.com"
 * Requests without it will receive HTTP 403.
 */

export const EDGAR_USER_AGENT =
  process.env.EDGAR_USER_AGENT ?? 'TradingJournalPro admin@tradingjournalpro.com'

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'

export interface InsiderPurchase {
  issuerName: string
  issuerTicker: string
  cik: string
  accessionNo: string
  insiderName: string
  insiderTitle: string
  transactionDate: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingUrl: string
}

// ---------------------------------------------------------------------------
// 1. Discover recent Form 4 filings via EDGAR full-text search
// ---------------------------------------------------------------------------

interface EdgarHit {
  _id: string
  _source: {
    period_of_report?: string
    entity_name?: string
    file_date?: string
    accession_no?: string
    ciks?: string[]
  }
}

export async function fetchRecentForm4Accessions(
  fromDate: string, // "YYYY-MM-DD"
  toDate: string    // "YYYY-MM-DD"
): Promise<EdgarHit[]> {
  const url = new URL(EDGAR_SEARCH)
  url.searchParams.set('q', '')
  url.searchParams.set('forms', '4')
  url.searchParams.set('dateRange', 'custom')
  url.searchParams.set('startdt', fromDate)
  url.searchParams.set('enddt', toDate)
  // Request up to 200 results per page (EDGAR maximum)
  url.searchParams.set('hits.hits._source.period_of_report', 'true')

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': EDGAR_USER_AGENT,
      Accept: 'application/json',
    },
    next: { revalidate: 0 },
  })

  if (!res.ok) {
    throw new Error(`EDGAR search HTTP ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()
  return (json?.hits?.hits as EdgarHit[]) ?? []
}

// ---------------------------------------------------------------------------
// 2. Fetch & parse a single Form 4 XML document
// ---------------------------------------------------------------------------

async function getFilingPrimaryDocument(
  cik: string,
  accessionNo: string
): Promise<string | null> {
  const acc = accessionNo.replace(/-/g, '')
  const indexUrl = `${EDGAR_ARCHIVES}/${cik}/${acc}/${acc}-index.json`

  const res = await fetch(indexUrl, {
    headers: { 'User-Agent': EDGAR_USER_AGENT },
    next: { revalidate: 0 },
  })
  if (!res.ok) return null

  const index = await res.json()
  const doc = (index?.documents as Array<{ type: string; document: string }> | undefined)?.find(
    (d) => d.type === '4' && d.document?.endsWith('.xml')
  )
  return doc ? `${EDGAR_ARCHIVES}/${cik}/${acc}/${doc.document}` : null
}

function extractText(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))?.[1]?.trim() ?? ''
}

function extractValueBlock(block: string, tag: string): string {
  // Form 4 XML wraps many fields in  <tag><value>X</value></tag>
  const inner = block.match(new RegExp(`<${tag}[\\s\\S]*?<value>([^<]*)<\\/value>[\\s\\S]*?<\\/${tag}>`))?.[1] ?? ''
  return inner.trim()
}

export async function parseForm4Purchases(
  cik: string,
  accessionNo: string,
  minValue: number
): Promise<InsiderPurchase[]> {
  const xmlUrl = await getFilingPrimaryDocument(cik, accessionNo)
  if (!xmlUrl) return []

  const res = await fetch(xmlUrl, {
    headers: { 'User-Agent': EDGAR_USER_AGENT },
    next: { revalidate: 0 },
  })
  if (!res.ok) return []

  const xml = await res.text()

  // Issuer
  const issuerName = extractText(xml, 'issuerName')
  const issuerTicker = extractText(xml, 'issuerTradingSymbol')

  // Reporting owner
  const insiderName = extractText(xml, 'rptOwnerName')
  const officerTitle = extractText(xml, 'officerTitle')
  const isDirector = /<isDirector>1<\/isDirector>/.test(xml)
  const isOfficer = /<isOfficer>1<\/isOfficer>/.test(xml)
  const insiderTitle =
    officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  // Non-derivative transactions (direct stock purchases)
  const ndSection =
    xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/)?.[1] ?? ''
  const txBlocks =
    ndSection.match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g) ?? []

  const purchases: InsiderPurchase[] = []

  for (const block of txBlocks) {
    const code = extractValueBlock(block, 'transactionCode')
    // "P" = open-market purchase (exclude "A" awards, "G" gifts, etc.)
    if (code !== 'P') continue

    const date = extractValueBlock(block, 'transactionDate')
    const sharesRaw = extractValueBlock(block, 'transactionShares')
    const priceRaw = extractValueBlock(block, 'transactionPricePerShare')

    const shares = parseFloat(sharesRaw) || 0
    const price = parseFloat(priceRaw) || 0
    const total = shares * price

    if (total < minValue) continue

    purchases.push({
      issuerName,
      issuerTicker,
      cik,
      accessionNo,
      insiderName,
      insiderTitle,
      transactionDate: date,
      shares,
      pricePerShare: price,
      totalValue: total,
      filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNo.replace(/-/g, '')}/${accessionNo}-index.htm`,
    })
  }

  return purchases
}

// ---------------------------------------------------------------------------
// 3. Orchestrate: fetch all filings for date range, filter, rank
// ---------------------------------------------------------------------------

export async function getInsiderPurchases(opts: {
  fromDate: string
  toDate: string
  minValue?: number
  maxFilings?: number
}): Promise<InsiderPurchase[]> {
  const { fromDate, toDate, minValue = 100_000, maxFilings = 200 } = opts

  const hits = await fetchRecentForm4Accessions(fromDate, toDate)
  const limited = hits.slice(0, maxFilings)

  // Fetch filings concurrently in batches of 10 to respect EDGAR rate limits
  const BATCH = 10
  const all: InsiderPurchase[] = []

  for (let i = 0; i < limited.length; i += BATCH) {
    const batch = limited.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map((hit) => {
        const cik = hit._source.ciks?.[0] ?? ''
        const acc = hit._source.accession_no ?? ''
        return cik && acc ? parseForm4Purchases(cik, acc, minValue) : Promise.resolve([])
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value)
    }
    // Polite pause between batches (EDGAR rate limit: ~10 req/s)
    if (i + BATCH < limited.length) {
      await new Promise((res) => setTimeout(res, 1100))
    }
  }

  // Sort by total value descending
  return all.sort((a, b) => b.totalValue - a.totalValue)
}

// ---------------------------------------------------------------------------
// 4. Format Slack message
// ---------------------------------------------------------------------------

const usd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

const MEDALS = ['🥇', '🥈', '🥉']

export function formatSlackReport(purchases: InsiderPurchase[], reportDate: string): string {
  if (purchases.length === 0) {
    return [
      `*🔍 SEC Form 4 Insider Purchases — ${reportDate}*`,
      `> Open-market buys ≥ $100,000 · Last 24 hours`,
      '',
      '_No qualifying purchases found for this period._',
    ].join('\n')
  }

  const rows = purchases.map((p, i) => {
    const rank = MEDALS[i] ?? `${i + 1}.`
    const ticker = p.issuerTicker ? `\`${p.issuerTicker}\`` : `_${p.issuerName}_`
    return [
      `${rank} *${ticker} — ${usd(p.totalValue)}*`,
      `   👤 ${p.insiderName}  _(${p.insiderTitle})_`,
      `   📊 ${num(p.shares)} shares @ ${usd(p.pricePerShare)}/sh · ${p.transactionDate}`,
      `   🔗 <${p.filingUrl}|SEC filing>`,
    ].join('\n')
  })

  return [
    `*🔍 SEC Form 4 Insider Purchases — ${reportDate}*`,
    `> Open-market buys ≥ $100,000 · Last 24 hours · Ranked by total value`,
    '',
    rows.join('\n\n'),
    '',
    `_${purchases.length} purchase${purchases.length !== 1 ? 's' : ''} found · Source: SEC EDGAR_`,
  ].join('\n')
}
