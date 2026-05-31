import { NextResponse } from 'next/server'

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_BASE = 'https://www.sec.gov'
const HEADERS = { 'User-Agent': 'TradingJournalPro contact@tradingjournal.pro' }
const DEFAULT_MIN_VALUE = 100_000

interface Purchase {
  security: string
  date: string
  shares: number
  price: number
  value: number
}

interface InsiderTrade {
  issuerName: string
  ticker: string
  ownerName: string
  role: string
  purchases: Purchase[]
  totalValue: number
  filedDate: string
}

function cikFromAccession(accessionNo: string): string {
  return String(parseInt(accessionNo.replace(/-/g, '').slice(0, 10), 10))
}

function findText(xml: string, tag: string): string {
  // Handles <tag><value>TEXT</value></tag> and <tag>TEXT</tag>
  const outer = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  if (!outer) return ''
  const inner = /<value[^>]*>([\s\S]*?)<\/value>/i.exec(outer[1])
  const text = inner ? inner[1] : outer[1]
  return text.replace(/<[^>]+>/g, '').trim()
}

function parseForm4Xml(xml: string, filedDate: string): InsiderTrade | null {
  const issuerName = findText(xml, 'issuerName')
  const ticker = findText(xml, 'issuerTradingSymbol')
  const ownerName = findText(xml, 'rptOwnerName')
  const isDirector = findText(xml, 'isDirector') === '1'
  const isOfficer = findText(xml, 'isOfficer') === '1'
  const officerTitle = findText(xml, 'officerTitle')

  if (!isDirector && !isOfficer) return null

  const role = isOfficer && officerTitle ? officerTitle : isDirector ? 'Director' : 'Insider'

  const txnBlocks = xml.match(/<nonDerivativeTransaction[\s\S]*?<\/nonDerivativeTransaction>/gi) ?? []
  const purchases: Purchase[] = []

  for (const block of txnBlocks) {
    const code = findText(block, 'transactionCode')
    const acqDisp = findText(block, 'transactionAcquiredDisposedCode')
    if (code !== 'P' || acqDisp !== 'A') continue

    const sharesStr = findText(block, 'transactionShares')
    const priceStr = findText(block, 'transactionPricePerShare')
    const shares = parseFloat(sharesStr)
    const price = parseFloat(priceStr)

    if (!shares || isNaN(shares) || !price || isNaN(price)) continue

    const value = shares * price
    purchases.push({
      security: findText(block, 'securityTitle'),
      date: findText(block, 'transactionDate'),
      shares,
      price,
      value,
    })
  }

  if (purchases.length === 0) return null

  return {
    issuerName,
    ticker,
    ownerName,
    role,
    purchases,
    totalValue: purchases.reduce((s, p) => s + p.value, 0),
    filedDate,
  }
}

async function fetchFilingsPage(startdt: string, enddt: string, from: number) {
  const url = new URL(EDGAR_SEARCH)
  url.searchParams.set('forms', '4')
  url.searchParams.set('dateRange', 'custom')
  url.searchParams.set('startdt', startdt)
  url.searchParams.set('enddt', enddt)
  url.searchParams.set('from', String(from))
  const res = await fetch(url.toString(), { headers: HEADERS })
  if (!res.ok) return null
  return res.json()
}

async function fetchXml(cik: string, accessionNo: string): Promise<string | null> {
  const accNodashes = accessionNo.replace(/-/g, '')
  // Fetch the index JSON to find the primary XML document
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNodashes}/${accessionNo}-index.json`
  try {
    const idxRes = await fetch(indexUrl, { headers: HEADERS })
    if (!idxRes.ok) return null
    const idx = await idxRes.json()
    const xmlDoc = (idx.documents as Array<{ type: string; filename: string }> | undefined)
      ?.find(d => d.type === '4' && d.filename.endsWith('.xml'))
      ?? idx.documents?.find((d: { filename: string }) => d.filename.endsWith('.xml'))
    if (!xmlDoc) return null
    const xmlUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNodashes}/${xmlDoc.filename}`
    const xmlRes = await fetch(xmlUrl, { headers: HEADERS })
    if (!xmlRes.ok) return null
    return xmlRes.text()
  } catch {
    return null
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const hours = Number(searchParams.get('hours') ?? 24)
  const minValue = Number(searchParams.get('minValue') ?? DEFAULT_MIN_VALUE)
  const maxFilings = Number(searchParams.get('maxFilings') ?? 300)

  const now = new Date()
  const cutoff = new Date(now.getTime() - hours * 3_600_000)
  const startdt = cutoff.toISOString().slice(0, 10)
  const enddt = now.toISOString().slice(0, 10)

  const allFilings: Array<{ accessionNo: string; fileDate: string }> = []

  // Page through search results
  let from = 0
  const pageSize = 100
  while (allFilings.length < maxFilings) {
    const data = await fetchFilingsPage(startdt, enddt, from)
    if (!data) break
    const hits: Array<{ _id: string; _source: { accession_no?: string; file_date?: string } }> =
      data?.hits?.hits ?? []
    if (hits.length === 0) break

    for (const hit of hits) {
      const src = hit._source ?? {}
      allFilings.push({
        accessionNo: src.accession_no ?? hit._id,
        fileDate: src.file_date ?? startdt,
      })
    }

    const total: number = data?.hits?.total?.value ?? 0
    from += pageSize
    if (from >= total) break
  }

  // Process filings concurrently in batches of 10
  const results: InsiderTrade[] = []
  const batchSize = 10
  for (let i = 0; i < allFilings.length; i += batchSize) {
    const batch = allFilings.slice(i, i + batchSize)
    const settled = await Promise.allSettled(
      batch.map(async ({ accessionNo, fileDate }) => {
        const cik = cikFromAccession(accessionNo)
        const xml = await fetchXml(cik, accessionNo)
        if (!xml) return null
        return parseForm4Xml(xml, fileDate)
      })
    )
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && r.value.totalValue >= minValue) {
        results.push(r.value)
      }
    }
  }

  results.sort((a, b) => b.totalValue - a.totalValue)

  return NextResponse.json({
    generatedAt: now.toISOString(),
    period: { startdt, enddt, hours },
    minValue,
    count: results.length,
    trades: results,
  })
}
