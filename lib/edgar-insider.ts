const EDGAR_BASE = 'https://www.sec.gov'
const EFTS_BASE = 'https://efts.sec.gov'
const MIN_PURCHASE_VALUE = 100_000
const MAX_FILINGS = 200

export interface InsiderBuy {
  insiderName: string
  insiderTitle: string
  isDirector: boolean
  isOfficer: boolean
  companyName: string
  ticker: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
  accessionNo: string
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function edgarFetch(url: string): Promise<Response> {
  const userAgent = process.env.EDGAR_USER_AGENT ?? 'TradingJournalPro research@tradingjournal.pro'
  return fetch(url, { headers: { 'User-Agent': userAgent } })
}

function extractCikFromAccession(accessionNo: string): string {
  // "0001234567-24-000001" → "1234567"
  return String(parseInt(accessionNo.split('-')[0], 10))
}

function extractXmlValue(xml: string, tag: string): string | null {
  // Form 4 XML wraps values: <tag><value>X</value></tag>
  const withValue = xml.match(new RegExp(`<${tag}[^>]*>\\s*<value>\\s*([^<]+)\\s*<\\/value>`, 'i'))
  if (withValue) return withValue[1].trim()
  // Fallback: <tag>X</tag> (plain text node)
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/`, 'i'))
  return plain ? plain[1].trim() : null
}

function extractOwnershipXml(sgmlText: string): string | null {
  const match = sgmlText.match(/<ownershipDocument>([\s\S]*?)<\/ownershipDocument>/i)
  return match ? `<ownershipDocument>${match[1]}</ownershipDocument>` : null
}

function parseInsiderBuys(xml: string, accessionNo: string, cik: string): InsiderBuy[] {
  const issuerName = extractXmlValue(xml, 'issuerName') ?? 'Unknown'
  const ticker = extractXmlValue(xml, 'issuerTradingSymbol') ?? ''
  const ownerName = extractXmlValue(xml, 'rptOwnerName') ?? 'Unknown'
  const isDirector = extractXmlValue(xml, 'isDirector') === '1'
  const isOfficer = extractXmlValue(xml, 'isOfficer') === '1'
  const officerTitle = extractXmlValue(xml, 'officerTitle') ?? (isDirector ? 'Director' : 'Insider')

  if (!isDirector && !isOfficer) return []

  const accNoDashes = accessionNo.replace(/-/g, '')
  const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accessionNo}-index.htm`

  const results: InsiderBuy[] = []
  const blocks = xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)

  for (const [, block] of blocks) {
    if (extractXmlValue(block, 'transactionCode') !== 'P') continue
    if (extractXmlValue(block, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(extractXmlValue(block, 'transactionShares') ?? '0')
    const price = parseFloat(extractXmlValue(block, 'transactionPricePerShare') ?? '0')
    const date = extractXmlValue(block, 'transactionDate') ?? ''

    if (!shares || !price) continue
    const totalValue = shares * price
    if (totalValue < MIN_PURCHASE_VALUE) continue

    results.push({
      insiderName: ownerName,
      insiderTitle: officerTitle,
      isDirector,
      isOfficer,
      companyName: issuerName,
      ticker,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate: date,
      filingUrl,
      accessionNo,
    })
  }

  return results
}

async function fetchAndParseFiling(accessionNo: string): Promise<InsiderBuy[]> {
  const cik = extractCikFromAccession(accessionNo)
  const accNoDashes = accessionNo.replace(/-/g, '')
  const url = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accessionNo}.txt`

  try {
    const res = await edgarFetch(url)
    if (!res.ok) return []
    const text = await res.text()
    const xml = extractOwnershipXml(text)
    if (!xml) return []
    return parseInsiderBuys(xml, accessionNo, cik)
  } catch {
    return []
  }
}

export async function fetchInsiderBuys(hoursBack = 24): Promise<InsiderBuy[]> {
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000)
  const startDate = since.toISOString().split('T')[0]
  const endDate = new Date().toISOString().split('T')[0]

  const accessions: string[] = []
  const pageSize = 40
  let from = 0

  while (accessions.length < MAX_FILINGS) {
    const url =
      `${EFTS_BASE}/LATEST/search-index?forms=4&dateRange=custom` +
      `&startdt=${startDate}&enddt=${endDate}&from=${from}&size=${pageSize}`
    const res = await edgarFetch(url)
    if (!res.ok) break
    const data = await res.json()
    const hits: { _id: string }[] = data.hits?.hits ?? []
    if (!hits.length) break

    for (const h of hits) accessions.push(h._id)

    const total: number = data.hits?.total?.value ?? 0
    if (from + pageSize >= total || from + pageSize >= MAX_FILINGS) break
    from += pageSize
    await sleep(200)
  }

  const allBuys: InsiderBuy[] = []
  for (const acc of accessions) {
    allBuys.push(...(await fetchAndParseFiling(acc)))
    await sleep(110) // stay under SEC's 10 req/sec limit
  }

  return allBuys.sort((a, b) => b.totalValue - a.totalValue)
}
