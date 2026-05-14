/**
 * SEC EDGAR Form 4 insider-purchase fetcher.
 *
 * Fetches recent Form 4 filings, parses the XML for open-market purchases
 * (transaction code "P", acquired "A") made by directors / officers, and
 * returns them ranked by total dollar value.
 *
 * Rate-limit note: EDGAR enforces ≤ 10 requests/sec. We honour that by
 * sleeping 120 ms between filing fetches.
 */

export interface InsiderPurchase {
  rank: number
  issuerName: string
  issuerTicker: string
  insiderName: string
  insiderTitle: string
  transactionDate: string
  security: string
  shares: number
  pricePerShare: number
  totalValue: number
  accessionNumber: string
  filingUrl: string
}

interface EdgarSearchHit {
  _id: string
  _source: {
    period_of_report?: string
    entity_name?: string
    display_names?: Array<{ name: string; id: string }>
    form_type?: string
  }
}

const USER_AGENT = 'TradingJournalPro/1.0 contact@tradingjournal.pro'
const EDGAR_BASE = 'https://www.sec.gov'
const SEARCH_BASE = 'https://efts.sec.gov'

async function edgarFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip, deflate',
    },
  })
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Returns YYYY-MM-DD strings for [now-24h, now]. */
function dateRange(): { startdt: string; enddt: string } {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { startdt: fmt(yesterday), enddt: fmt(now) }
}

/** Fetch list of Form 4 filing IDs from EDGAR full-text search. */
async function fetchFilingList(
  startdt: string,
  enddt: string,
  maxHits = 100
): Promise<EdgarSearchHit[]> {
  const url =
    `${SEARCH_BASE}/LATEST/search-index` +
    `?forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}` +
    `&hits.hits.total.value=true&hits.hits.hits.total=${maxHits}`

  const res = await edgarFetch(url)
  if (!res.ok) throw new Error(`EDGAR search failed: ${res.status}`)

  const data = (await res.json()) as {
    hits?: { hits?: EdgarSearchHit[] }
  }
  return data.hits?.hits ?? []
}

/** Fetches the raw XML text for one Form 4 filing. */
async function fetchForm4Xml(
  cik: string,
  accession: string
): Promise<string | null> {
  const acc = accession.replace(/-/g, '')

  // Try the filing index first to find the exact XML filename.
  try {
    const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${acc}/${accession}-index.json`
    const idx = await edgarFetch(indexUrl)
    if (idx.ok) {
      const idxData = (await idx.json()) as {
        documents?: Array<{ type: string; document: string }>
      }
      const xmlDoc = idxData.documents?.find(
        (d) => d.type === '4' && d.document.endsWith('.xml')
      )
      if (xmlDoc) {
        const xmlUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${acc}/${xmlDoc.document}`
        const xmlRes = await edgarFetch(xmlUrl)
        if (xmlRes.ok) return xmlRes.text()
      }
    }
  } catch {}

  // Fallback: accession-number.xml naming convention.
  try {
    const fallback = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${acc}/${accession}.xml`
    const res = await edgarFetch(fallback)
    if (res.ok) return res.text()
  } catch {}

  return null
}

/** Extracts the text content of the first XML element matching a simple tag path. */
function xmlText(xml: string, ...tags: string[]): string {
  for (const tag of tags) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
    if (m) return m[1].trim()
  }
  return ''
}

/** Parses a Form 4 XML string and returns qualifying purchase records. */
function parseForm4(xml: string, accession: string): Omit<InsiderPurchase, 'rank'>[] {
  const issuerName = xmlText(xml, 'issuerName')
  const issuerTicker = xmlText(xml, 'issuerTradingSymbol').toUpperCase()

  const insiderName = xmlText(xml, 'rptOwnerName')
  const isDirector = xmlText(xml, 'isDirector') === '1'
  const isOfficer = xmlText(xml, 'isOfficer') === '1'
  const officerTitle = xmlText(xml, 'officerTitle')

  if (!isDirector && !isOfficer) return []

  const insiderTitle =
    officerTitle || (isDirector ? 'Director' : 'Officer')

  const purchases: Omit<InsiderPurchase, 'rank'>[] = []

  // Pull every <nonDerivativeTransaction> block and inspect it.
  const txnRegex =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let txnMatch: RegExpExecArray | null

  while ((txnMatch = txnRegex.exec(xml)) !== null) {
    const block = txnMatch[1]

    const code = xmlText(block, 'transactionCode')
    const acqDisp = xmlText(block, 'transactionAcquiredDisposedCode')

    if (code !== 'P' || acqDisp !== 'A') continue

    const sharesStr = xmlText(block, 'transactionShares')
    const priceStr = xmlText(block, 'transactionPricePerShare')
    const dateStr = xmlText(block, 'transactionDate')
    const security =
      xmlText(block, 'securityTitle') || 'Common Stock'

    const shares = parseFloat(sharesStr.replace(/,/g, ''))
    const price = parseFloat(priceStr.replace(/,/g, ''))

    if (!isFinite(shares) || !isFinite(price) || shares <= 0 || price <= 0)
      continue

    const totalValue = shares * price
    const cikInAcc = accession.split('-')[0].replace(/^0+/, '')

    purchases.push({
      issuerName,
      issuerTicker,
      insiderName,
      insiderTitle,
      transactionDate: dateStr,
      security,
      shares,
      pricePerShare: price,
      totalValue,
      accessionNumber: accession,
      filingUrl: `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${cikInAcc}&type=4&dateb=&owner=include&count=10`,
    })
  }

  return purchases
}

/**
 * Main entry point.
 * Returns insider purchases from the last 24 hours, filtered to ≥ minValue,
 * sorted by totalValue descending.
 */
export async function fetchInsiderPurchases(
  minValue = 100_000,
  maxFilings = 80
): Promise<InsiderPurchase[]> {
  const { startdt, enddt } = dateRange()
  const hits = await fetchFilingList(startdt, enddt, maxFilings)

  const allPurchases: Omit<InsiderPurchase, 'rank'>[] = []

  for (const hit of hits) {
    const accession = hit._id
    const displayNames = hit._source.display_names ?? []
    const rawCik = displayNames[0]?.id ?? ''
    if (!rawCik) continue

    // EDGAR CIK is zero-padded to 10 digits in URLs
    const cik = rawCik.replace(/^0+/, '') || rawCik

    const xml = await fetchForm4Xml(cik, accession)
    if (xml) {
      const found = parseForm4(xml, accession)
      allPurchases.push(...found)
    }

    await sleep(120) // respect EDGAR rate limit
  }

  const filtered = allPurchases
    .filter((p) => p.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue)

  return filtered.map((p, i) => ({ ...p, rank: i + 1 }))
}

export function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(2)}`
}
