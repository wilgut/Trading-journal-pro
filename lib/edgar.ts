const SEC_BASE = 'https://www.sec.gov'
const EDGAR_EFTS = 'https://efts.sec.gov/LATEST/search-index'
const USER_AGENT = process.env.SEC_USER_AGENT ?? 'TradingJournalPro contact@example.com'

export interface InsiderPurchase {
  accessionNumber: string
  issuerName: string
  issuerTicker: string
  ownerName: string
  ownerTitle: string
  transactionDate: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingUrl: string
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

// Extracts text content of the first matching simple XML tag
function tag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim() ?? ''
}

// Extracts the <value> child of an EDGAR XML field (most fields wrap their data in <value>)
function valueTag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}>\\s*<value>([^<]*)<\\/value>`))?.[1]?.trim() ?? ''
}

function cikFromAccession(acc: string): string {
  return String(parseInt(acc.split('-')[0], 10))
}

async function secFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate' }
  })
}

// Fetches the filing index HTML and extracts the primary Form 4 XML URL
async function getXmlUrl(cik: string, accNoDash: string): Promise<string | null> {
  try {
    const res = await secFetch(
      `${SEC_BASE}/Archives/edgar/data/${cik}/${accNoDash}/${accNoDash}-index.htm`
    )
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/href="([^"]*\.xml)"/i)
    if (!m) return null
    const path = m[1]
    if (path.startsWith('http')) return path
    return path.startsWith('/')
      ? `${SEC_BASE}${path}`
      : `${SEC_BASE}/Archives/edgar/data/${cik}/${accNoDash}/${path}`
  } catch {
    return null
  }
}

function parseTransactions(xml: string, acc: string, cik: string): InsiderPurchase[] {
  const issuerName = tag(xml, 'issuerName')
  const issuerTicker = tag(xml, 'issuerTradingSymbol').toUpperCase()
  const ownerName = tag(xml, 'rptOwnerName')
  const officerTitle = tag(xml, 'officerTitle')
  const isDirector = tag(xml, 'isDirector') === '1'
  const ownerTitle = officerTitle || (isDirector ? 'Director' : 'Insider')

  const accNoDash = acc.replace(/-/g, '')
  const filingUrl = `${SEC_BASE}/Archives/edgar/data/${cik}/${accNoDash}/${accNoDash}-index.htm`
  const purchases: InsiderPurchase[] = []

  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const block = m[1]
    // 'P' = open-market purchase; skip options exercises and gifts
    if (tag(block, 'transactionCode') !== 'P') continue
    // Skip disposals (should be 'A' for acquired, but guard anyway)
    if (valueTag(block, 'transactionAcquiredDisposedCode') === 'D') continue

    const shares = parseFloat(valueTag(block, 'transactionShares'))
    const price = parseFloat(valueTag(block, 'transactionPricePerShare'))
    if (!shares || !price || isNaN(shares) || isNaN(price) || price <= 0) continue

    purchases.push({
      accessionNumber: acc,
      issuerName,
      issuerTicker,
      ownerName,
      ownerTitle,
      transactionDate: valueTag(block, 'transactionDate'),
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      filingUrl,
    })
  }
  return purchases
}

async function processBatch(
  hits: Array<{ _id: string }>,
  minValue: number
): Promise<InsiderPurchase[]> {
  const results: InsiderPurchase[] = []
  await Promise.all(
    hits.map(async ({ _id: acc }) => {
      const accNoDash = acc.replace(/-/g, '')
      const cik = cikFromAccession(acc)
      const xmlUrl = await getXmlUrl(cik, accNoDash)
      if (!xmlUrl) return
      await sleep(50)
      try {
        const res = await secFetch(xmlUrl)
        if (!res.ok) return
        const xml = await res.text()
        results.push(...parseTransactions(xml, acc, cik).filter(t => t.totalValue >= minValue))
      } catch {
        // skip filings that fail to parse
      }
    })
  )
  return results
}

export async function fetchInsiderPurchases(
  minValue = 100_000,
  maxFilings = 150
): Promise<InsiderPurchase[]> {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)

  const url = new URL(EDGAR_EFTS)
  url.searchParams.set('forms', '4')
  url.searchParams.set('dateRange', 'custom')
  url.searchParams.set('startdt', yesterday.toISOString().slice(0, 10))
  url.searchParams.set('enddt', now.toISOString().slice(0, 10))
  url.searchParams.set('from', '0')
  url.searchParams.set('size', String(Math.min(maxFilings, 100)))

  const res = await secFetch(url.toString())
  if (!res.ok) throw new Error(`EDGAR search failed: ${res.status} ${res.statusText}`)

  const data = (await res.json()) as {
    hits?: { hits?: Array<{ _id: string }>; total?: { value: number } }
  }
  const hits = data.hits?.hits ?? []

  const allPurchases: InsiderPurchase[] = []
  const batchSize = 5

  for (let i = 0; i < hits.length; i += batchSize) {
    const batch = hits.slice(i, i + batchSize)
    allPurchases.push(...(await processBatch(batch, minValue)))
    // Stay well under SEC's 10 req/s limit between batches
    if (i + batchSize < hits.length) await sleep(300)
  }

  return allPurchases.sort((a, b) => b.totalValue - a.totalValue)
}
