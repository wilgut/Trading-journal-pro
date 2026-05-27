// ─────────────────────────────────────────────────────────────────────────────
//  SEC EDGAR Form 4 Fetcher & Parser
//
//  Data sources used:
//    1. EDGAR EFTS search API  → list recent Form 4 filings
//       https://efts.sec.gov/LATEST/search-index?forms=4&...
//    2. EDGAR Archives         → filing directory listing (HTML)
//       https://www.sec.gov/Archives/edgar/data/{cik}/{accNoHyphens}/
//    3. Form 4 primary XML     → actual transaction data
//       https://www.sec.gov/Archives/edgar/data/{cik}/{accNoHyphens}/{doc}.xml
//
//  SEC requires: User-Agent header with app name + contact email.
//  Rate limit: 10 req/s — we batch with 200 ms gaps between batches of 5.
// ─────────────────────────────────────────────────────────────────────────────

import type { FilingMeta, InsiderTrade } from './types'

const EDGAR_BASE   = 'https://www.sec.gov'
const EFTS_BASE    = 'https://efts.sec.gov'
const USER_AGENT   =
  `TradingJournalPro/1.0 ${process.env.CONTACT_EMAIL ?? 'WILFRED.GUTIERREZ@gmail.com'}`

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function edgarFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/xml, application/xml, */*',
    },
    // Respect EDGAR's recommendation of no caching for real-time data
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`EDGAR HTTP ${res.status} — ${url}`)
  }
  return res
}

// ── XML helpers ───────────────────────────────────────────────────────────────

/** Return the text content of the first matching XML element. */
function xmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  return xml.match(re)?.[1]?.trim() ?? ''
}

/** Return all block contents for a given element name. */
function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

/**
 * In Form 4 XML most leaf data lives inside a nested <value> element:
 *   <transactionShares><value>500</value></transactionShares>
 * This helper extracts that inner value.
 */
function xmlValueOf(xml: string, tag: string): string {
  const block = xmlText(xml, tag)
  const nested = xmlText(block, 'value')
  return nested || block
}

// ── Step 1: EDGAR EFTS search ─────────────────────────────────────────────────

/**
 * Fetch all Form 4 filings filed in the last `hoursBack` hours.
 * Pages through the EFTS API in batches of 40 (EDGAR max = 40 per page).
 */
export async function fetchRecentForm4Filings(hoursBack = 24): Promise<FilingMeta[]> {
  const now   = new Date()
  const since = new Date(now.getTime() - hoursBack * 3_600_000)

  const startdt = since.toISOString().slice(0, 10)
  const enddt   = now.toISOString().slice(0, 10)

  const all: FilingMeta[] = []
  let from = 0

  while (from < 800) {
    const url =
      `${EFTS_BASE}/LATEST/search-index?forms=4` +
      `&dateRange=custom&startdt=${startdt}&enddt=${enddt}` +
      `&from=${from}`

    const data: {
      hits: {
        total: { value: number }
        hits: Array<{
          _id: string
          _source: {
            entity_id?: string
            entity_name?: string
            file_date?: string
          }
        }>
      }
    } = await edgarFetch(url).then(r => r.json())

    const hits = data.hits?.hits ?? []
    if (hits.length === 0) break

    for (const hit of hits) {
      const accNum = hit._id                          // e.g. "0001234567-24-000001"
      // CIK is the first segment of the accession number (10-digit, may have leading zeros)
      const cikRaw = accNum.split('-')[0]
      const cik    = parseInt(cikRaw, 10).toString() // strip leading zeros

      all.push({
        accessionNumber: accNum,
        cik:             hit._source?.entity_id ?? cik,
        fileDate:        hit._source?.file_date  ?? enddt,
        entityName:      hit._source?.entity_name ?? '',
      })
    }

    const total = data.hits?.total?.value ?? 0
    from += hits.length
    if (from >= Math.min(total, 600)) break

    await sleep(150) // respect 10 req/s rate limit
  }

  return all
}

// ── Step 2: Locate Form 4 XML document ───────────────────────────────────────

/**
 * Given an accession number + CIK, find the filename of the primary Form 4
 * XML document by fetching the filing's directory listing from EDGAR Archives.
 *
 * Falls back to `{accessionNumber}.xml` if the directory listing is unavailable.
 */
async function findPrimaryXmlDocument(
  cik: string,
  accNoHyphens: string,
  accessionNumber: string,
): Promise<string> {
  try {
    // EDGAR Archives directory listing is plain HTML
    const dirUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoHyphens}/`
    const html   = await edgarFetch(dirUrl).then(r => r.text())

    // Find href links ending in .xml that are NOT the stylesheet wrapper
    const xmlFiles = [...html.matchAll(/href="([^"]+\.xml)"/gi)]
      .map(m => m[1])
      .filter(f => !f.includes('xsl') && !f.includes('viewer'))

    if (xmlFiles.length > 0) {
      // Prefer the file whose name contains the accession number pattern
      const primary = xmlFiles.find(f =>
        f.includes(accNoHyphens) || f.match(/form[_-]?4/i)
      ) ?? xmlFiles[0]
      // Strip any leading path
      return primary.split('/').pop()!
    }
  } catch {
    // fall through to default name
  }

  // Common fallback: EDGAR often names the primary document after the accession number
  return `${accessionNumber}.xml`
}

// ── Step 3: Parse Form 4 XML ─────────────────────────────────────────────────

/**
 * Parse Form 4 XML and return all open-market PURCHASE transactions (code "P").
 *
 * Form 4 XML structure overview:
 *   <ownershipDocument>
 *     <issuer>
 *       <issuerName>Apple Inc.</issuerName>
 *       <issuerTradingSymbol>AAPL</issuerTradingSymbol>
 *     </issuer>
 *     <reportingOwner>
 *       <reportingOwnerId>
 *         <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
 *       </reportingOwnerId>
 *       <reportingOwnerRelationship>
 *         <isDirector>0</isDirector>
 *         <isOfficer>1</isOfficer>
 *         <officerTitle>CEO</officerTitle>
 *       </reportingOwnerRelationship>
 *     </reportingOwner>
 *     <nonDerivativeTable>
 *       <nonDerivativeTransaction>
 *         <transactionCoding>
 *           <transactionCode>P</transactionCode>  ← open-market purchase
 *         </transactionCoding>
 *         <transactionAmounts>
 *           <transactionShares><value>1000</value></transactionShares>
 *           <transactionPricePerShare><value>185.50</value></transactionPricePerShare>
 *           <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
 *         </transactionAmounts>
 *         <postTransactionAmounts>
 *           <sharesOwnedFollowingTransaction><value>10000</value></sharesOwnedFollowingTransaction>
 *         </postTransactionAmounts>
 *       </nonDerivativeTransaction>
 *     </nonDerivativeTable>
 *   </ownershipDocument>
 */
export function parseForm4Xml(xml: string, meta: FilingMeta): InsiderTrade[] {
  const trades: InsiderTrade[] = []

  // ── Issuer ────────────────────────────────────────────────────────────────
  const issuerBlock = xmlText(xml, 'issuer')
  const companyName = xmlText(issuerBlock, 'issuerName')
  const ticker      = xmlText(issuerBlock, 'issuerTradingSymbol').toUpperCase()

  if (!companyName) return [] // malformed — skip

  // ── Reporting owner ───────────────────────────────────────────────────────
  const ownerIdBlock   = xmlText(xml, 'reportingOwnerId')
  const insiderName    = xmlText(ownerIdBlock, 'rptOwnerName')

  const relBlock          = xmlText(xml, 'reportingOwnerRelationship')
  const isDirector        = xmlText(relBlock, 'isDirector') === '1'
  const isOfficer         = xmlText(relBlock, 'isOfficer') === '1'
  const isTenPercentOwner = xmlText(relBlock, 'isTenPercentOwner') === '1'
  const officerTitle      = xmlText(relBlock, 'officerTitle')
  const insiderTitle      = officerTitle
    || (isDirector ? 'Director' : isOfficer ? 'Officer' : isTenPercentOwner ? '10% Owner' : 'Insider')

  const filingUrl =
    `${EDGAR_BASE}/Archives/edgar/data/${meta.cik}/` +
    `${meta.accessionNumber.replace(/-/g, '')}/${meta.accessionNumber}-index.htm`

  // ── Non-derivative transactions (stock purchases, not options) ────────────
  for (const txBlock of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    // Only open-market purchases
    const codingBlock   = xmlText(txBlock, 'transactionCoding')
    const txCode        = xmlText(codingBlock, 'transactionCode')
    if (txCode !== 'P') continue

    const amtsBlock     = xmlText(txBlock, 'transactionAmounts')
    const acquiredDisposed = xmlValueOf(amtsBlock, 'transactionAcquiredDisposedCode')
    if (acquiredDisposed !== 'A') continue // must be an acquisition, not disposal

    const shares      = parseFloat(xmlValueOf(amtsBlock, 'transactionShares'))      || 0
    const price       = parseFloat(xmlValueOf(amtsBlock, 'transactionPricePerShare')) || 0
    const postBlock   = xmlText(txBlock, 'postTransactionAmounts')
    const sharesAfter = parseFloat(xmlValueOf(postBlock, 'sharesOwnedFollowingTransaction')) || 0
    // transactionDate block: <transactionDate><value>2024-01-15</value></transactionDate>
    const txDateBlock = xmlText(txBlock, 'transactionDate')
    const txDate      = xmlText(txDateBlock, 'value') || txDateBlock || meta.fileDate

    if (shares <= 0 || price <= 0) continue

    trades.push({
      rank:            0, // set later
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      isDirector,
      isOfficer,
      isTenPercentOwner,
      transactionDate: txDate,
      shares,
      pricePerShare:   price,
      totalValue:      shares * price,
      sharesOwnedAfter: sharesAfter,
      filingDate:      meta.fileDate,
      filingUrl,
      accessionNumber: meta.accessionNumber,
    })
  }

  return trades
}

// ── Step 4: Fetch + parse a single filing ─────────────────────────────────────

export async function fetchAndParseFiling(meta: FilingMeta): Promise<InsiderTrade[]> {
  const accNoHyphens = meta.accessionNumber.replace(/-/g, '')

  const docName = await findPrimaryXmlDocument(meta.cik, accNoHyphens, meta.accessionNumber)
  const xmlUrl  = `${EDGAR_BASE}/Archives/edgar/data/${meta.cik}/${accNoHyphens}/${docName}`

  const xml = await edgarFetch(xmlUrl).then(r => r.text())
  return parseForm4Xml(xml, meta)
}

// ── Step 5: Full pipeline ─────────────────────────────────────────────────────

/**
 * Main entry point.
 *
 * Fetches all Form 4 filings in the last `hoursBack` hours, parses each one,
 * filters for open-market purchases ≥ `minValue`, and returns them ranked by
 * total dollar value (highest first).
 *
 * @param hoursBack  Look-back window in hours (default: 24)
 * @param minValue   Minimum total purchase value in USD (default: $100,000)
 * @param concurrency Number of filings to fetch in parallel (default: 5)
 */
export async function getSignificantInsiderPurchases(
  hoursBack   = 24,
  minValue    = 100_000,
  concurrency = 5,
): Promise<InsiderTrade[]> {
  const filings = await fetchRecentForm4Filings(hoursBack)

  const allTrades: InsiderTrade[] = []

  // Process in small batches to respect EDGAR's rate limits
  for (let i = 0; i < filings.length; i += concurrency) {
    const batch = filings.slice(i, i + concurrency)

    const results = await Promise.allSettled(batch.map(fetchAndParseFiling))

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTrades.push(...result.value)
      }
      // Silently skip individual filing parse errors
    }

    if (i + concurrency < filings.length) {
      await sleep(200) // ≤ 10 req/s
    }
  }

  // Filter, deduplicate, sort, and rank
  const meaningful = allTrades
    .filter(t => t.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue)

  return meaningful.map((t, i) => ({ ...t, rank: i + 1 }))
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}
