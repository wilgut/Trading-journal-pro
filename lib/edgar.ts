const EDGAR_BASE = 'https://www.sec.gov'
const EDGAR_EFTS = 'https://efts.sec.gov/LATEST/search-index'
// EDGAR requires a descriptive User-Agent; change to your contact info
const USER_AGENT = process.env.EDGAR_USER_AGENT ?? 'TradingJournalPro contact@tradingjournal.pro'

export interface InsiderPurchase {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  transactionDate: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingUrl: string
  filedAt: string
  securityTitle: string
}

interface EftsHit {
  _id: string
  _source: {
    entity_name: string
    file_date: string
    period_of_report: string
    form_type: string
    display_names?: string[]
  }
}

function edgarHeaders(accept = 'application/json') {
  return { 'User-Agent': USER_AGENT, Accept: accept }
}

/** Pull the text content of the first matching XML element (handles <tag><value>…</value></tag> nesting). */
function xmlValue(xml: string, tag: string): string {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>\\s*(?:<value>\\s*)?([^<]+?)\\s*(?:<\\/value>)?\\s*<\\/${tag}>`,
    'is',
  )
  return xml.match(re)?.[1]?.trim() ?? ''
}

function parseForm4Purchases(xml: string, filingUrl: string, filedAt: string): InsiderPurchase[] {
  const companyName = xmlValue(xml, 'issuerName')
  const ticker = xmlValue(xml, 'issuerTradingSymbol')
  const insiderName = xmlValue(xml, 'rptOwnerName')

  // Relationship flags (may appear as <isDirector>1</isDirector> or <isDirector><value>1</value></isDirector>)
  const isDirector = /isDirector[^>]*>(?:<value>)?1(?:<\/value>)?<\/isDirector/i.test(xml)
  const isOfficer = /isOfficer[^>]*>(?:<value>)?1(?:<\/value>)?<\/isOfficer/i.test(xml)

  // Skip filings from non-executives (e.g., 10% owners who aren't officers/directors)
  if (!isDirector && !isOfficer) return []

  const officerTitleMatch = xml.match(/<officerTitle>(?:<value>)?([^<]+?)(?:<\/value>)?<\/officerTitle>/i)
  let title = officerTitleMatch?.[1]?.trim() ?? ''
  if (!title) title = isDirector && isOfficer ? 'Director & Officer' : isDirector ? 'Director' : 'Officer'

  const purchases: InsiderPurchase[] = []
  const txRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let m: RegExpExecArray | null

  while ((m = txRe.exec(xml)) !== null) {
    const tx = m[1]

    // Only open-market purchases (transactionCode P)
    const code = tx.match(/<transactionCode>([^<]+)<\/transactionCode>/i)?.[1]?.trim().toUpperCase()
    if (code !== 'P') continue

    // Must be an acquisition
    const adCode = tx
      .match(/<transactionAcquiredDisposedCode>(?:<value>)?([^<]+?)(?:<\/value>)?<\/transactionAcquiredDisposedCode>/i)?.[1]
      ?.trim()
      .toUpperCase()
    if (adCode && adCode !== 'A') continue

    const secTitle = xmlValue(tx, 'securityTitle')
    const txDate = tx.match(/<transactionDate>(?:<value>)?([^<]+?)(?:<\/value>)?<\/transactionDate>/i)?.[1]?.trim()
    const sharesStr = tx.match(/<transactionShares>(?:<value>)?([^<]+?)(?:<\/value>)?<\/transactionShares>/i)?.[1]
    const priceStr = tx.match(
      /<transactionPricePerShare>(?:<value>)?([^<]+?)(?:<\/value>)?<\/transactionPricePerShare>/i,
    )?.[1]

    const shares = sharesStr ? parseFloat(sharesStr) : NaN
    const price = priceStr ? parseFloat(priceStr) : NaN

    if (!shares || !price || isNaN(shares) || isNaN(price) || price <= 0) continue

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle: title,
      transactionDate: txDate ?? filedAt,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      filingUrl,
      filedAt,
      securityTitle: secTitle,
    })
  }

  return purchases
}

async function fetchAndParseForm4(hit: EftsHit): Promise<InsiderPurchase[]> {
  // _id: "edgar/data/{cik}/{accessionNoDashes}/{accessionDashes}-index.htm"
  const idMatch = hit._id.match(/edgar\/data\/(\d+)\/(\d+)\//)
  if (!idMatch) return []

  const cik = idMatch[1]
  const accNoDashes = idMatch[2]
  const accDashes = `${accNoDashes.slice(0, 10)}-${accNoDashes.slice(10, 12)}-${accNoDashes.slice(12)}`
  const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accDashes}-index.htm`

  // Filing index JSON → find the primary Form 4 XML document
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accDashes}-index.json`
  const indexRes = await fetch(indexUrl, { headers: edgarHeaders() })
  if (!indexRes.ok) return []

  const index = await indexRes.json()
  const docs = (index.documents ?? []) as Array<{ type: string; filename: string; description?: string }>
  const xmlDoc = docs.find(
    d => d.type === '4' || (d.filename?.endsWith('.xml') && !d.filename.includes('R')),
  )
  if (!xmlDoc) return []

  const xmlUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${xmlDoc.filename}`
  const xmlRes = await fetch(xmlUrl, { headers: edgarHeaders('text/xml,application/xml,*/*') })
  if (!xmlRes.ok) return []

  const xml = await xmlRes.text()
  return parseForm4Purchases(xml, filingUrl, hit._source.file_date ?? '')
}

async function searchForm4Filings(startdt: string, enddt: string, from = 0, size = 40): Promise<EftsHit[]> {
  const url =
    `${EDGAR_EFTS}?q=&forms=4&dateRange=custom` +
    `&startdt=${startdt}&enddt=${enddt}&from=${from}&size=${size}`
  const res = await fetch(url, { headers: edgarHeaders() })
  if (!res.ok) throw new Error(`EDGAR EFTS ${res.status}: ${url}`)
  const data = await res.json()
  return (data.hits?.hits ?? []) as EftsHit[]
}

/**
 * Returns insider open-market purchases filed with the SEC in the last `hoursBack` hours,
 * filtered to transactions with a total value ≥ `minValue`, sorted largest first.
 */
export async function getInsiderPurchases(
  minValue = 100_000,
  hoursBack = 24,
): Promise<InsiderPurchase[]> {
  const now = new Date()
  const start = new Date(now.getTime() - hoursBack * 3_600_000)
  const fmt = (d: Date) => d.toISOString().split('T')[0]

  // Collect up to two pages of filings (EDGAR EFTS caps at 10 by default without size param)
  const [page1, page2] = await Promise.all([
    searchForm4Filings(fmt(start), fmt(now), 0, 40),
    searchForm4Filings(fmt(start), fmt(now), 40, 40),
  ])
  const hits = [...page1, ...page2]

  const all: InsiderPurchase[] = []
  const BATCH = 5

  for (let i = 0; i < hits.length; i += BATCH) {
    const batch = hits.slice(i, i + BATCH)
    const results = await Promise.allSettled(batch.map(fetchAndParseForm4))
    results.forEach(r => r.status === 'fulfilled' && all.push(...r.value))
    // Respectful throttle between batches per EDGAR fair-use policy
    if (i + BATCH < hits.length) await new Promise(r => setTimeout(r, 300))
  }

  return all.filter(p => p.totalValue >= minValue).sort((a, b) => b.totalValue - a.totalValue)
}
