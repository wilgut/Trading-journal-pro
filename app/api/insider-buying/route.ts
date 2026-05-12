import { NextResponse } from 'next/server'

const MIN_PURCHASE_VALUE = 100_000
const USER_AGENT = 'TradingJournalPro contact@tradingjournal.pro'
const EDGAR_EFTS = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'

export interface InsiderPurchase {
  ticker: string
  companyName: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingDate: string
  accessionNumber: string
}

function extractText(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}>([^<]+)<\\/${tag}>`))?.[1]?.trim() ?? ''
}

function extractBlockValue(block: string, outerTag: string): number {
  const match = block.match(new RegExp(`<${outerTag}>[\\s\\S]*?<value>([^<]+)<\\/value>`))
  return parseFloat(match?.[1] ?? '0') || 0
}

function parseForm4(xml: string, fileDate: string, accessionNumber: string): InsiderPurchase[] {
  const companyName = extractText(xml, 'issuerName')
  const ticker = extractText(xml, 'issuerTradingSymbol')
  const insiderName = extractText(xml, 'rptOwnerName')

  // Only process directors and officers (not 10% owners who aren't insiders)
  const isDirector = /<isDirector>1<\/isDirector>/.test(xml)
  const isOfficer = /<isOfficer>1<\/isOfficer>/.test(xml)
  if (!isDirector && !isOfficer) return []

  const officerTitle = extractText(xml, 'officerTitle')
  const insiderTitle = officerTitle || (isDirector ? 'Director' : 'Insider')

  const results: InsiderPurchase[] = []
  const txBlocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? []

  for (const block of txBlocks) {
    const code = extractText(block, 'transactionCode')
    // Code 'P' = open market purchase (not 'S' sale, 'A' award, etc.)
    if (code !== 'P') continue

    const shares = extractBlockValue(block, 'transactionShares')
    const price = extractBlockValue(block, 'transactionPricePerShare')
    const totalValue = shares * price

    if (totalValue >= MIN_PURCHASE_VALUE && ticker) {
      results.push({
        ticker,
        companyName,
        insiderName,
        insiderTitle,
        shares,
        pricePerShare: price,
        totalValue,
        filingDate: fileDate,
        accessionNumber,
      })
    }
  }

  return results
}

async function edgarFetch<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      next: { revalidate: 0 },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      next: { revalidate: 0 },
    })
    return res.ok ? res.text() : null
  } catch {
    return null
  }
}

async function getFilingXml(accession: string): Promise<string | null> {
  // Filer CIK is encoded in the first segment of the accession number
  const cik = accession.split('-')[0].replace(/^0+/, '')
  const cleanAccession = accession.replace(/-/g, '')

  type IndexFile = { name: string; type: string }
  type IndexJson = { directory: { item: IndexFile[] } }

  const index = await edgarFetch<IndexJson>(
    `${EDGAR_ARCHIVES}/${cik}/${cleanAccession}/${accession}-index.json`
  )
  if (!index?.directory?.item) return null

  // Prefer a typed XML doc; skip the -index.xml summary
  const xmlFile =
    index.directory.item.find(
      (f) => f.type === 'application/xml' && !f.name.endsWith('-index.xml')
    ) ?? index.directory.item.find((f) => f.name.endsWith('.xml') && !f.name.endsWith('-index.xml'))

  if (!xmlFile) return null

  return fetchXml(`${EDGAR_ARCHIVES}/${cik}/${cleanAccession}/${xmlFile.name}`)
}

export async function GET() {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  const endDate = now.toISOString().slice(0, 10)
  const startDate = yesterday.toISOString().slice(0, 10)

  const params = new URLSearchParams({
    forms: '4',
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: '0',
    size: '40',
  })

  type EftsSource = { file_date: string; entity_name: string }
  type EftsHit = { _id: string; _source: EftsSource }
  type EftsResponse = { hits: { total: { value: number }; hits: EftsHit[] } }

  const data = await edgarFetch<EftsResponse>(`${EDGAR_EFTS}?${params}`)
  if (!data) {
    return NextResponse.json({ error: 'Failed to reach SEC EDGAR' }, { status: 502 })
  }

  const hits = data.hits?.hits ?? []
  const purchases: InsiderPurchase[] = []

  // Process in batches of 8 to stay within EDGAR's rate limits
  const BATCH = 8
  const limit = Math.min(hits.length, 40)

  for (let i = 0; i < limit; i += BATCH) {
    const batch = hits.slice(i, i + BATCH)
    const batchResults = await Promise.all(
      batch.map(async (hit) => {
        const xml = await getFilingXml(hit._id)
        if (!xml) return []
        return parseForm4(xml, hit._source.file_date, hit._id)
      })
    )
    purchases.push(...batchResults.flat())
  }

  const ranked = purchases.sort((a, b) => b.totalValue - a.totalValue)

  return NextResponse.json({
    purchases: ranked,
    count: ranked.length,
    totalFilingsScanned: hits.length,
    dateRange: { from: startDate, to: endDate },
    asOf: now.toISOString(),
  })
}
