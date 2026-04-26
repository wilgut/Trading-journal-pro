const EDGAR_BROWSE   = 'https://www.sec.gov/cgi-bin/browse-edgar'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'
// SEC requires a descriptive User-Agent with a contact address
const USER_AGENT = 'TradingJournalPro contact@tradingjournalpro.io'

export const MIN_PURCHASE_VALUE = 100_000

export type InsiderPurchase = {
  rank: number
  filerName: string
  officerTitle: string
  issuerName: string
  issuerTicker: string
  securityTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingDate: string
  accessionNo: string
  filingUrl: string
}

type FilingMeta = {
  cik: string
  accessionNo: string
  accessionNoDashes: string
  filingDate: string
  filingUrl: string
}

const edgar = (url: string) =>
  fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/xml,*/*' },
    signal: AbortSignal.timeout(15_000),
  })

// Paginate the EDGAR "current filings" Atom feed for Form 4.
// Each entry's <link> encodes the issuer CIK directly in the URL path.
async function fetchFilingMetas(since: Date): Promise<FilingMeta[]> {
  const PAGE_SIZE = 40
  const MAX_PAGES = 15          // caps at ~600 filings per run
  const metas: FilingMeta[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${EDGAR_BROWSE}?action=getcurrent&type=4&dateb=&owner=include` +
      `&count=${PAGE_SIZE}&start=${page * PAGE_SIZE}&output=atom`

    const res = await edgar(url)
    if (!res.ok) throw new Error(`EDGAR browse returned HTTP ${res.status}`)

    const xml    = await res.text()
    let hitOld   = false
    let entryCount = 0

    for (const [, block] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      entryCount++
      const updated = block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim()
      if (!updated || new Date(updated) < since) { hitOld = true; continue }

      const href = block.match(/<link[^>]+href="([^"]+)"/)?.[1]
      if (!href) continue

      // href format: .../Archives/edgar/data/{CIK}/{ACC_NO_DASHES}/…-index.htm
      const m = href.match(/\/Archives\/edgar\/data\/(\d+)\/(\d+)\//i)
      if (!m) continue

      const cik              = m[1]
      const accessionNoDashes = m[2]
      const accessionNo = accessionNoDashes.replace(
        /^(\d{10})(\d{2})(\d{6})$/, '$1-$2-$3',
      )

      metas.push({ cik, accessionNo, accessionNoDashes, filingDate: updated.slice(0, 10), filingUrl: href })
    }

    if (hitOld || entryCount < PAGE_SIZE) break
  }

  return metas
}

// Fetch the raw Form 4 XML for a single filing.
async function fetchForm4Xml(cik: string, accessionNoDashes: string): Promise<string | null> {
  const base     = `${EDGAR_ARCHIVES}/${parseInt(cik, 10)}/${accessionNoDashes}`
  const indexUrl = `${base}/${accessionNoDashes}-index.json`

  try {
    const idx = await edgar(indexUrl)
    if (!idx.ok) return null

    const { directory } = await idx.json()
    const items: Array<{ name: string }> = directory?.item ?? []

    // Primary Form 4 XML — skip inline XBRL renders named R1.xml, R2.xml, …
    const xmlFile = items.find(f => f.name.endsWith('.xml') && !/^R\d+\.xml$/.test(f.name))
    if (!xmlFile) return null

    const xmlRes = await edgar(`${base}/${xmlFile.name}`)
    return xmlRes.ok ? xmlRes.text() : null
  } catch {
    return null
  }
}

// Extract purchase transactions from Form 4 XML.
// Targets <nonDerivativeTransaction> blocks with transactionCode = P (open-market purchase)
// and transactionAcquiredDisposedCode = A (acquired).
function parseForm4(
  xml: string,
  filingDate: string,
  filingUrl: string,
  accessionNo: string,
): InsiderPurchase[] {
  const tag = (name: string, src = xml) =>
    src.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim() ?? ''
  const val = (name: string, src: string) =>
    src.match(new RegExp(`<${name}>[\\s\\S]*?<value>([\\s\\S]*?)<\\/value>`))?.[1]?.trim() ?? ''

  const issuerName   = tag('issuerName')
  const issuerTicker = tag('issuerTradingSymbol')
  const filerName    = tag('rptOwnerName')
  const officerTitle = tag('officerTitle')

  const results: InsiderPurchase[] = []

  for (const [, block] of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    if (tag('transactionCode', block) !== 'P') continue
    if (val('transactionAcquiredDisposedCode', block) !== 'A') continue

    const shares = parseFloat(val('transactionShares', block) || '0')
    const price  = parseFloat(val('transactionPricePerShare', block) || '0')
    if (shares <= 0 || price <= 0) continue

    const totalValue = shares * price
    if (totalValue < MIN_PURCHASE_VALUE) continue

    results.push({
      rank:           0,
      filerName:      filerName    || 'Unknown',
      officerTitle:   officerTitle || '',
      issuerName:     issuerName   || 'Unknown',
      issuerTicker,
      securityTitle:  val('securityTitle', block) || 'Common Stock',
      shares,
      pricePerShare:  price,
      totalValue,
      transactionDate: val('transactionDate', block) || filingDate,
      filingDate,
      accessionNo,
      filingUrl,
    })
  }

  return results
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  const worker = async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j]) }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function fetchInsiderPurchases(hoursBack = 24): Promise<InsiderPurchase[]> {
  const since = new Date(Date.now() - hoursBack * 3_600_000)
  const metas = await fetchFilingMetas(since)

  // Fetch XMLs 5 at a time to stay well within SEC's 10-req/s rate limit
  const nested = await withConcurrency(metas, 5, async meta => {
    const xml = await fetchForm4Xml(meta.cik, meta.accessionNoDashes)
    return xml ? parseForm4(xml, meta.filingDate, meta.filingUrl, meta.accessionNo) : []
  })

  return nested
    .flat()
    .sort((a, b) => b.totalValue - a.totalValue)
    .map((p, idx) => ({ ...p, rank: idx + 1 }))
}
