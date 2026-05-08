const EDGAR_BASE = 'https://www.sec.gov'
const EFTS_BASE = 'https://efts.sec.gov'

// EDGAR access policy requires a User-Agent with contact info
const EDGAR_UA =
  process.env.EDGAR_USER_AGENT ?? 'Trading-Journal-Pro admin@example.com'

const EDGAR_HEADERS: HeadersInit = {
  'User-Agent': EDGAR_UA,
  Accept: 'application/json, text/xml, */*',
}

export interface InsiderPurchase {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  securityTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingDate: string
  accessionNo: string
  filingUrl: string
}

interface EftsHit {
  _id: string
  _source: {
    accession_no?: string
    entity_name?: string
    file_date?: string
    form_type?: string
    period_of_report?: string
  }
}

interface IndexItem {
  name: string
  type?: string
}

async function searchRecentForm4s(
  startDate: string,
  endDate: string,
  size: number,
): Promise<EftsHit[]> {
  const params = new URLSearchParams({
    q: '',
    forms: '4',
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: '0',
    size: String(size),
  })

  const res = await fetch(`${EFTS_BASE}/LATEST/search-index?${params}`, {
    headers: EDGAR_HEADERS,
    cache: 'no-store',
  })

  if (!res.ok)
    throw new Error(`EDGAR EFTS search error: ${res.status} ${res.statusText}`)

  const json = await res.json()
  return (json?.hits?.hits as EftsHit[]) ?? []
}

async function findXmlDocumentUrl(
  cik: string,
  accNoDashes: string,
): Promise<string | null> {
  const url = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/index.json`
  const res = await fetch(url, { headers: EDGAR_HEADERS, cache: 'no-store' })
  if (!res.ok) return null

  let json: { directory?: { item?: IndexItem[] } }
  try {
    json = await res.json()
  } catch {
    return null
  }

  const items = json?.directory?.item ?? []

  // Prefer a file explicitly typed as Form 4; fall back to any .xml
  const xmlDoc =
    items.find((i) => i.type === '4' && i.name.endsWith('.xml')) ??
    items.find((i) => i.name.endsWith('.xml') && !/graphic|xsd/i.test(i.name))

  if (!xmlDoc) return null
  return `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${xmlDoc.name}`
}

// ---------- XML helpers ----------

function extractTagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
  return m?.[1]?.trim() ?? ''
}

// Extracts <value>X</value> from inside a named outer tag anywhere in the block
function extractValueIn(block: string, tag: string): string {
  const outer = block.match(
    new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`),
  )
  if (!outer) return ''
  return extractTagText(outer[0], 'value')
}

function parseTransactions(
  xml: string,
  fileDate: string,
  accNo: string,
): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = []

  const companyName = extractTagText(xml, 'issuerName')
  const ticker = extractTagText(xml, 'issuerTradingSymbol')
  // Skip filings with no exchange ticker (private / unlisted issuers)
  if (!ticker) return []

  const insiderName = extractTagText(xml, 'rptOwnerName')
  const officerTitle = extractTagText(xml, 'officerTitle')
  const isDirector = extractTagText(xml, 'isDirector') === '1'
  const is10Pct = extractTagText(xml, 'isTenPercentOwner') === '1'

  const insiderTitle =
    officerTitle ||
    (isDirector ? 'Director' : '') ||
    (is10Pct ? '10% Owner' : '') ||
    'Insider'

  const cik = String(parseInt(accNo.replace(/-/g, '').slice(0, 10), 10))
  const accNoDashes = accNo.replace(/-/g, '')
  const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/`

  const nonDerivRx =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g
  let m: RegExpExecArray | null

  while ((m = nonDerivRx.exec(xml)) !== null) {
    const tx = m[1]

    // Only open-market purchases (code P) that are acquisitions (A)
    if (extractTagText(tx, 'transactionCode') !== 'P') continue
    if (extractValueIn(tx, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(extractValueIn(tx, 'transactionShares'))
    const pricePerShare = parseFloat(
      extractValueIn(tx, 'transactionPricePerShare'),
    )

    if (
      !isFinite(shares) ||
      !isFinite(pricePerShare) ||
      shares <= 0 ||
      pricePerShare <= 0
    )
      continue

    const totalValue = shares * pricePerShare
    const transactionDate =
      extractValueIn(tx, 'transactionDate') || fileDate
    const securityTitle =
      extractValueIn(tx, 'securityTitle') || 'Common Stock'

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      securityTitle,
      shares,
      pricePerShare,
      totalValue,
      transactionDate,
      filingDate: fileDate,
      accessionNo: accNo,
      filingUrl,
    })
  }

  return purchases
}

// ---------- Public API ----------

export async function fetchInsiderPurchases(
  minValue = 100_000,
  maxFilings = 200,
): Promise<InsiderPurchase[]> {
  const now = new Date()
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  const hits = await searchRecentForm4s(fmt(since), fmt(now), maxFilings)

  const all: InsiderPurchase[] = []
  const BATCH = 10

  for (let i = 0; i < hits.length; i += BATCH) {
    const batch = hits.slice(i, i + BATCH)

    const settled = await Promise.allSettled(
      batch.map(async (hit) => {
        const accNo: string =
          hit._source?.accession_no ?? hit._id ?? ''
        if (!accNo) return []

        const accNoDashes = accNo.replace(/-/g, '')
        const cik = String(
          parseInt(accNoDashes.slice(0, 10), 10),
        )
        const fileDate = hit._source?.file_date ?? fmt(now)

        const xmlUrl = await findXmlDocumentUrl(cik, accNoDashes)
        if (!xmlUrl) return []

        const xmlRes = await fetch(xmlUrl, {
          headers: EDGAR_HEADERS,
          cache: 'no-store',
        })
        if (!xmlRes.ok) return []

        const xml = await xmlRes.text()
        return parseTransactions(xml, fileDate, accNo)
      }),
    )

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        for (const p of r.value) {
          if (p.totalValue >= minValue) all.push(p)
        }
      }
    }

    // Stay within EDGAR's 10 req/s guideline between batches
    if (i + BATCH < hits.length) {
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  return all.sort((a, b) => b.totalValue - a.totalValue)
}
