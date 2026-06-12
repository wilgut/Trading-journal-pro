export interface InsiderBuy {
  companyName: string
  ticker: string
  executiveName: string
  title: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
  cik: string
  accessionNumber: string
}

const EDGAR_BASE = 'https://www.sec.gov'
const EFTS_BASE = 'https://efts.sec.gov'
// SEC requires a descriptive User-Agent with contact info
const USER_AGENT = 'TradingJournalPro insider-monitor/1.0 contact@trading-journal-pro.app'

async function edgarFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`EDGAR ${res.status}: ${url}`)
  return res
}

// Extracts <tag><value>X</value></tag> or <tag>X</tag> patterns from XML
function xmlValue(xml: string, tag: string): string {
  const nested = xml.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]*)</value>`, 'is'))
  if (nested) return nested[1].trim()
  const direct = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'is'))
  return direct ? direct[1].trim() : ''
}

function parseForm4(xml: string, filingUrl: string): InsiderBuy[] {
  const buys: InsiderBuy[] = []

  const companyName = xmlValue(xml, 'issuerName')
  const ticker = xmlValue(xml, 'issuerTradingSymbol').toUpperCase()
  const executiveName = xmlValue(xml, 'rptOwnerName')
  const officerTitle = xmlValue(xml, 'officerTitle')
  const isDirector = xmlValue(xml, 'isDirector') === '1'
  const title = officerTitle || (isDirector ? 'Director' : 'Insider')

  // Skip filings with no issuer (e.g., mutual fund forms misfiled as form 4)
  if (!companyName && !ticker) return []

  const txRegex = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let m: RegExpExecArray | null
  while ((m = txRegex.exec(xml)) !== null) {
    const tx = m[1]
    const code = xmlValue(tx, 'transactionCode')
    const adc = xmlValue(tx, 'transactionAcquiredDisposedCode')

    // P = open-market Purchase; A = Acquired (not disposed)
    if (code !== 'P' || adc !== 'A') continue

    const shares = parseFloat(xmlValue(tx, 'transactionShares')) || 0
    const price = parseFloat(xmlValue(tx, 'transactionPricePerShare')) || 0
    const date = xmlValue(tx, 'transactionDate')

    if (shares > 0 && price > 0) {
      buys.push({
        companyName,
        ticker,
        executiveName,
        title,
        shares,
        pricePerShare: price,
        totalValue: shares * price,
        transactionDate: date,
        filingUrl,
        cik: '',
        accessionNumber: '',
      })
    }
  }

  return buys
}

async function getXmlUrl(cik: string, accNoDashes: string): Promise<string | null> {
  try {
    const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accNoDashes}-index.json`
    const res = await edgarFetch(indexUrl)
    const data = await res.json() as { documents?: Array<{ name: string; type: string }> }
    const docs = data.documents ?? []

    // Prefer the document typed "4"; fall back to any .xml
    const primary =
      docs.find(d => d.type === '4' && d.name.endsWith('.xml')) ??
      docs.find(d => d.name.endsWith('.xml'))

    return primary
      ? `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${primary.name}`
      : null
  } catch {
    return null
  }
}

async function processBatch(ids: string[]): Promise<InsiderBuy[]> {
  const results: InsiderBuy[] = []

  for (const id of ids) {
    // Accession format: 0001234567-24-000001
    const parts = id.match(/^(\d{10})-(\d{2})-(\d+)$/)
    if (!parts) continue

    const cik = parseInt(parts[1], 10).toString() // strip leading zeros for path
    const accNoDashes = id.replace(/-/g, '')
    const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/`

    try {
      const xmlUrl = await getXmlUrl(cik, accNoDashes)
      if (!xmlUrl) continue

      // ~150 ms gap keeps us comfortably under SEC's 10 req/s guideline
      await new Promise(r => setTimeout(r, 150))

      const xml = await (await edgarFetch(xmlUrl)).text()
      const buys = parseForm4(xml, filingUrl)
      buys.forEach(b => { b.cik = cik; b.accessionNumber = id })
      results.push(...buys)
    } catch {
      // Skip individual filing failures; continue with the rest
    }
  }

  return results
}

export async function fetchInsiderBuys(): Promise<InsiderBuy[]> {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const startdt = yesterday.toISOString().split('T')[0]
  const enddt = today.toISOString().split('T')[0]

  const searchUrl =
    `${EFTS_BASE}/LATEST/search-index?forms=4` +
    `&dateRange=custom&startdt=${startdt}&enddt=${enddt}` +
    `&from=0&size=200`

  const res = await edgarFetch(searchUrl)
  const data = await res.json() as { hits?: { hits?: Array<{ _id: string }> } }
  const hits = data.hits?.hits ?? []

  if (hits.length === 0) return []

  // Process in concurrent batches of 5 to respect rate limits
  const BATCH = 5
  const all: InsiderBuy[] = []
  for (let i = 0; i < hits.length; i += BATCH) {
    const ids = hits.slice(i, i + BATCH).map(h => h._id)
    const batch = await processBatch(ids)
    all.push(...batch)
    // Extra pause between batches
    if (i + BATCH < hits.length) await new Promise(r => setTimeout(r, 500))
  }

  return all
}
