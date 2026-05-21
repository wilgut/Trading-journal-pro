/**
 * SEC EDGAR Form 4 fetcher and parser.
 * Retrieves insider purchase transactions filed within a given date range.
 *
 * SEC rate-limit policy: max 10 req/s per IP. We use a semaphore to cap
 * concurrent requests and add small delays between pages.
 */

const EFTS_URL = 'https://efts.sec.gov/LATEST/search-index'
const ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data'

// SEC requires a descriptive User-Agent with contact info for programmatic access
const USER_AGENT = 'TradingJournalPro research@tradingjournalpro.com'

export interface InsiderTrade {
  ownerName: string
  ownerTitle: string
  isDirector: boolean
  isOfficer: boolean
  companyName: string
  ticker: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  securityTitle: string
  filingUrl: string
  cik: string
  accessionNo: string
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the text content of a named XML tag.
 * Handles both direct values (<tag>val</tag>) and SEC's nested <value> pattern
 * (<tag><value>val</value></tag>).
 */
function tagValue(xml: string, tag: string): string {
  // Nested <value> form (most Form 4 numeric/date fields)
  let m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*<value>([^<]*)</value>\\s*</${tag}>`, 'i'))
  if (m) return m[1].trim()

  // Direct text form (e.g. <issuerName>, <isDirector>)
  m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]+)</${tag}>`, 'i'))
  if (m) return m[1].trim()

  return ''
}

function boolTag(xml: string, tag: string): boolean {
  return /1|true/i.test(tagValue(xml, tag))
}

// ---------------------------------------------------------------------------
// Form 4 XML parser
// ---------------------------------------------------------------------------

export function parseForm4(xml: string, cik: string, accessionNo: string): InsiderTrade[] {
  const trades: InsiderTrade[] = []

  const companyName = tagValue(xml, 'issuerName')
  const ticker = tagValue(xml, 'issuerTradingSymbol').toUpperCase().trim()
  const ownerName = tagValue(xml, 'rptOwnerName')
  const isDirector = boolTag(xml, 'isDirector')
  const isOfficer = boolTag(xml, 'isOfficer')
  const officerTitle = tagValue(xml, 'officerTitle')

  const ownerTitle =
    officerTitle ||
    (isDirector && isOfficer ? 'Director & Officer' : isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  const cleanAccession = accessionNo.replace(/-/g, '')

  // Iterate over every <nonDerivativeTransaction> block
  const blockRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g
  let m: RegExpExecArray | null

  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1]

    // "P" = open-market purchase
    const transCode = tagValue(block, 'transactionCode')
    if (transCode !== 'P') continue

    const acquiredDisposed = tagValue(block, 'transactionAcquiredDisposedCode')
    // Ensure it is an acquisition (A), not a disposition (D)
    if (acquiredDisposed && acquiredDisposed !== 'A') continue

    const shares = parseFloat(tagValue(block, 'transactionShares'))
    const price = parseFloat(tagValue(block, 'transactionPricePerShare'))

    if (!isFinite(shares) || !isFinite(price) || shares <= 0 || price <= 0) continue

    const totalValue = shares * price
    if (totalValue < 100_000) continue

    trades.push({
      ownerName,
      ownerTitle,
      isDirector,
      isOfficer,
      companyName,
      ticker,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate: tagValue(block, 'transactionDate'),
      securityTitle: tagValue(block, 'securityTitle'),
      filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanAccession}/${accessionNo}-index.htm`,
      cik,
      accessionNo,
    })
  }

  return trades
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function edgarFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/xml, */*',
    },
    // Next.js: bypass cache so we always get fresh data
    cache: 'no-store',
  })
}

interface FilingMeta {
  cik: string // company (issuer) CIK from EFTS entity_id
  accessionNo: string
}

async function searchFilings(
  startDate: string,
  endDate: string,
  from: number,
  size: number,
): Promise<{ filings: FilingMeta[]; total: number }> {
  const url =
    `${EFTS_URL}?forms=4&dateRange=custom` +
    `&startdt=${startDate}&enddt=${endDate}` +
    `&from=${from}&hits.hits.total.value=true&hits.hits._source.entity_id=true`

  const res = await edgarFetch(url)
  if (!res.ok) return { filings: [], total: 0 }

  const data = await res.json()
  const total: number = data.hits?.total?.value ?? 0

  const filings: FilingMeta[] = (data.hits?.hits ?? []).map((h: Record<string, unknown>) => {
    const src = (h._source ?? {}) as Record<string, unknown>
    // entity_id may arrive as a number or zero-padded string
    const rawCik = String(src.entity_id ?? '').replace(/^0+/, '') || ''
    const accessionNo = String(src.accession_no ?? '')
    return { cik: rawCik, accessionNo }
  })

  return { filings, total }
}

async function fetchXml(cik: string, accessionNo: string): Promise<string | null> {
  const cleanAccession = accessionNo.replace(/-/g, '')

  // 1. Try the filing index JSON to locate the primary Form 4 XML document
  const indexUrl = `${ARCHIVES_URL}/${cik}/${cleanAccession}/${accessionNo}-index.json`
  try {
    const idxRes = await edgarFetch(indexUrl)
    if (idxRes.ok) {
      const idx = await idxRes.json()
      const items: Array<Record<string, string>> = idx.directory?.item ?? []

      // Find the first .xml file that is not the full-submission bundle
      const xmlEntry = items.find(
        (f) => f.name?.endsWith('.xml') && !f.name.includes('full-submission'),
      )

      if (xmlEntry) {
        const xmlRes = await edgarFetch(`${ARCHIVES_URL}/${cik}/${cleanAccession}/${xmlEntry.name}`)
        if (xmlRes.ok) return xmlRes.text()
      }
    }
  } catch {
    // fall through to the direct approach
  }

  // 2. Fallback: the primary document is often named after the accession number
  try {
    const directUrl = `${ARCHIVES_URL}/${cik}/${cleanAccession}/${accessionNo}.xml`
    const res = await edgarFetch(directUrl)
    if (res.ok) return res.text()
  } catch {
    /* ignore */
  }

  return null
}

// ---------------------------------------------------------------------------
// Simple concurrency semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private pending: Array<() => void> = []
  private slots: number

  constructor(max: number) {
    this.slots = max
  }

  acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--
      return Promise.resolve()
    }
    return new Promise((resolve) => this.pending.push(resolve))
  }

  release(): void {
    const next = this.pending.shift()
    if (next) {
      next()
    } else {
      this.slots++
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches all Form 4 filings between startDate and endDate (YYYY-MM-DD),
 * parses each XML, filters for open-market purchases > $100 K, and returns
 * results sorted by total value descending.
 *
 * @param maxFilings  Cap the number of filings fetched (default 200).
 *                    Each filing requires 2 HTTP requests (index + XML).
 */
export async function fetchInsiderPurchases(
  startDate: string,
  endDate: string,
  maxFilings = 200,
): Promise<InsiderTrade[]> {
  // --- 1. Collect filing metadata via paginated EFTS search ---
  const allFilings: FilingMeta[] = []
  const PAGE = 40

  outer: for (let from = 0; ; from += PAGE) {
    const { filings, total } = await searchFilings(startDate, endDate, from, PAGE)

    for (const f of filings) {
      allFilings.push(f)
      if (allFilings.length >= maxFilings) break outer
    }

    if (filings.length < PAGE || allFilings.length >= total) break
    // Polite delay between pages
    await new Promise((r) => setTimeout(r, 150))
  }

  // --- 2. Fetch and parse each filing concurrently (max 8 in-flight) ---
  const sem = new Semaphore(8)
  const allTrades: InsiderTrade[] = []

  const results = await Promise.allSettled(
    allFilings.map(async ({ cik, accessionNo }) => {
      await sem.acquire()
      try {
        if (!cik || !accessionNo) return []
        const xml = await fetchXml(cik, accessionNo)
        return xml ? parseForm4(xml, cik, accessionNo) : []
      } finally {
        sem.release()
      }
    }),
  )

  for (const r of results) {
    if (r.status === 'fulfilled') allTrades.push(...r.value)
  }

  return allTrades.sort((a, b) => b.totalValue - a.totalValue)
}
