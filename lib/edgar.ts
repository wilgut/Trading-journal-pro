import { format, subDays } from 'date-fns'

const EDGAR_EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVE_BASE = 'https://www.sec.gov/Archives/edgar/data'
// SEC requires a descriptive User-Agent with contact info
const SEC_USER_AGENT = 'TradingJournalPro/1.0 admin@example.com'

const MAX_FILINGS_TO_PROCESS = 200
const CONCURRENT_REQUESTS = 5
// 100ms between batches keeps us well under the 10 req/sec SEC limit
const BATCH_DELAY_MS = 100

export interface InsiderBuy {
  issuerName: string
  issuerTicker: string
  reporterName: string
  reporterTitle: string
  transactionDate: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingUrl: string
}

interface EdgarHit {
  _id: string
  _source: {
    period_of_report?: string
    entity_name?: string
    file_date?: string
    entity_id?: string
  }
}

// Extracts text from an XML tag, unwrapping nested <value> if present
function xmlGet(xml: string, tag: string): string {
  const outer = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  if (!outer) return ''
  const inner = outer[1]
  const valueMatch = inner.match(/<value>([^<]*)<\/value>/i)
  return valueMatch ? valueMatch[1].trim() : inner.trim()
}

async function secFetch(url: string, accept = 'application/json'): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': SEC_USER_AGENT,
      Accept: accept,
    },
  })
}

async function searchForm4Page(
  startDate: string,
  endDate: string,
  from: number
): Promise<{ hits: EdgarHit[]; total: number }> {
  const params = new URLSearchParams({
    q: '""',
    forms: '4',
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: String(from),
  })

  const res = await secFetch(`${EDGAR_EFTS_BASE}?${params}`)
  if (!res.ok) return { hits: [], total: 0 }

  const data = await res.json()
  return {
    hits: data.hits?.hits ?? [],
    total: data.hits?.total?.value ?? 0,
  }
}

async function fetchForm4XML(
  cik: string,
  accessionNoDashes: string,
  primaryFilename: string
): Promise<string | null> {
  // If the primary document is already an XML file, fetch it directly
  if (primaryFilename.endsWith('.xml')) {
    const res = await secFetch(
      `${EDGAR_ARCHIVE_BASE}/${cik}/${accessionNoDashes}/${primaryFilename}`,
      'text/xml'
    )
    if (res.ok) return res.text()
  }

  // Fall back to scanning the directory index for the Form 4 XML
  const indexRes = await secFetch(
    `${EDGAR_ARCHIVE_BASE}/${cik}/${accessionNoDashes}/`,
    'text/html'
  )
  if (!indexRes.ok) return null

  const html = await indexRes.text()
  // Prefer files with form4/doc4 in name, fall back to any xml
  const xmlMatch =
    html.match(/href="([^"]*(?:form4|doc4|wf-form4)[^"]*\.xml)"/i) ||
    html.match(/href="([^"]+\.xml)"/i)
  if (!xmlMatch) return null

  const xmlFilename = xmlMatch[1].split('/').pop()!
  const xmlRes = await secFetch(
    `${EDGAR_ARCHIVE_BASE}/${cik}/${accessionNoDashes}/${xmlFilename}`,
    'text/xml'
  )
  return xmlRes.ok ? xmlRes.text() : null
}

function accessionWithDashes(noDashes: string): string {
  // Format: 10-digit filer CIK + 2-digit year + 6-digit sequence
  return noDashes.replace(/^(\d{10})(\d{2})(\d{6})$/, '$1-$2-$3')
}

function parseTransactions(xml: string, filingUrl: string): InsiderBuy[] {
  const issuerName = xmlGet(xml, 'issuerName')
  const issuerTicker = xmlGet(xml, 'issuerTradingSymbol').toUpperCase()
  const reporterName = xmlGet(xml, 'rptOwnerName')

  const isDirector = /<isDirector>1<\/isDirector>/i.test(xml)
  const isOfficer = /<isOfficer>1<\/isOfficer>/i.test(xml)
  const officerTitle = xmlGet(xml, 'officerTitle')

  let reporterTitle = 'Insider'
  if (isOfficer && officerTitle) reporterTitle = officerTitle
  else if (isDirector && isOfficer) reporterTitle = 'Director/Officer'
  else if (isDirector) reporterTitle = 'Director'
  else if (isOfficer) reporterTitle = 'Officer'

  const results: InsiderBuy[] = []
  const txPattern = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let match: RegExpExecArray | null

  while ((match = txPattern.exec(xml)) !== null) {
    const txXml = match[1]

    // Only open-market purchases (code "P")
    if (xmlGet(txXml, 'transactionCode') !== 'P') continue

    // Must be Acquired, not Disposed (empty = assume A when code is P)
    const adCode = xmlGet(txXml, 'transactionAcquiredDisposedCode')
    if (adCode && adCode !== 'A') continue

    const shares = parseFloat(xmlGet(txXml, 'transactionShares')) || 0
    const price = parseFloat(xmlGet(txXml, 'transactionPricePerShare')) || 0
    if (shares <= 0 || price <= 0) continue

    results.push({
      issuerName,
      issuerTicker,
      reporterName,
      reporterTitle,
      transactionDate: xmlGet(txXml, 'transactionDate'),
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      filingUrl,
    })
  }

  return results
}

async function processOneFiling(hit: EdgarHit): Promise<InsiderBuy[]> {
  // _id format from EDGAR EFTS: edgar/data/{cik}/{accessionNoDashes}/{filename}
  const parts = hit._id.replace(/^edgar\/data\//, '').split('/')
  if (parts.length < 2) return []

  const [cik, accessionNoDashes, primaryFilename = ''] = parts
  if (!cik || !accessionNoDashes) return []

  const acc = accessionWithDashes(accessionNoDashes)
  const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoDashes}/${acc}-index.htm`

  try {
    const xml = await fetchForm4XML(cik, accessionNoDashes, primaryFilename)
    if (!xml) return []
    return parseTransactions(xml, filingUrl)
  } catch {
    return []
  }
}

export async function getInsiderBuys(minValue = 100_000): Promise<InsiderBuy[]> {
  const today = new Date()
  const endDate = format(today, 'yyyy-MM-dd')
  const startDate = format(subDays(today, 1), 'yyyy-MM-dd')

  // Get first page + total count
  const first = await searchForm4Page(startDate, endDate, 0)
  const allHits: EdgarHit[] = [...first.hits]

  // Paginate up to MAX_FILINGS_TO_PROCESS (20 results per EDGAR page)
  const pagesToFetch = Math.min(first.total, MAX_FILINGS_TO_PROCESS)
  if (pagesToFetch > 20) {
    const pageOffsets = Array.from(
      { length: Math.ceil((pagesToFetch - 20) / 20) },
      (_, i) => (i + 1) * 20
    )
    const pages = await Promise.all(
      pageOffsets.map(from => searchForm4Page(startDate, endDate, from))
    )
    for (const page of pages) allHits.push(...page.hits)
  }

  const limited = allHits.slice(0, MAX_FILINGS_TO_PROCESS)

  // Process filings in concurrent batches, respecting SEC rate limits
  const allBuys: InsiderBuy[] = []
  for (let i = 0; i < limited.length; i += CONCURRENT_REQUESTS) {
    const batch = limited.slice(i, i + CONCURRENT_REQUESTS)
    const results = await Promise.all(batch.map(processOneFiling))
    for (const buys of results) allBuys.push(...buys)

    if (i + CONCURRENT_REQUESTS < limited.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return allBuys
    .filter(b => b.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue)
}
