export interface InsiderTrade {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  transactionDate: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingUrl: string
}

const USER_AGENT = 'TradingJournalPro/1.0 (WILFRED.GUTIERREZ@gmail.com)'
const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'
const EFTS = 'https://efts.sec.gov/LATEST/search-index'

// Extract direct text content: <tag>text</tag>
function xmlText(xml: string, tag: string): string {
  const open = `<${tag}`
  const close = `</${tag}>`
  const si = xml.indexOf(open)
  if (si === -1) return ''
  const contentStart = xml.indexOf('>', si) + 1
  const ei = xml.indexOf(close, contentStart)
  if (ei === -1) return ''
  return xml.slice(contentStart, ei).trim()
}

// Extract value from: <tag><value>text</value>...</tag>
function xmlValue(xml: string, tag: string): string {
  const open = `<${tag}`
  const close = `</${tag}>`
  const si = xml.indexOf(open)
  if (si === -1) return ''
  const ei = xml.indexOf(close, si)
  if (ei === -1) return ''
  const block = xml.slice(si, ei)
  const vs = block.indexOf('<value>')
  if (vs === -1) return ''
  const ve = block.indexOf('</value>', vs)
  if (ve === -1) return ''
  return block.slice(vs + 7, ve).trim()
}

// Extract all blocks matching <tag>...</tag>
function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = []
  const open = `<${tag}`
  const close = `</${tag}>`
  let pos = 0
  while (pos < xml.length) {
    const s = xml.indexOf(open, pos)
    if (s === -1) break
    const e = xml.indexOf(close, s)
    if (e === -1) break
    blocks.push(xml.slice(s, e + close.length))
    pos = e + close.length
  }
  return blocks
}

async function secFetch(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    })
    return res.ok ? res : null
  } catch {
    return null
  }
}

async function processOneFiling(
  accessionNo: string,
  fileDate: string
): Promise<InsiderTrade[]> {
  const accNoNoDash = accessionNo.replace(/-/g, '')
  const cik = String(parseInt(accNoNoDash.slice(0, 10), 10))

  const indexRes = await secFetch(
    `${ARCHIVES}/${cik}/${accNoNoDash}/${accessionNo}-index.json`
  )
  if (!indexRes) return []

  const items: Array<{ type: string; href: string }> =
    (await indexRes.json()).directory?.item ?? []

  const xmlItem = items.find(
    d => d.type === '4' && typeof d.href === 'string' && d.href.endsWith('.xml')
  )
  if (!xmlItem) return []

  const xmlUrl = `${ARCHIVES}/${cik}/${accNoNoDash}/${xmlItem.href}`
  const filingUrl = `${ARCHIVES}/${cik}/${accNoNoDash}/${accessionNo}-index.htm`

  const xmlRes = await secFetch(xmlUrl)
  if (!xmlRes) return []

  const xml = await xmlRes.text()

  const companyName = xmlText(xml, 'issuerName') || 'Unknown'
  const ticker = xmlText(xml, 'issuerTradingSymbol')
  const insiderName = xmlText(xml, 'rptOwnerName') || 'Unknown'
  const officerTitle = xmlText(xml, 'officerTitle')
  const isDirector = xmlText(xml, 'isDirector') === '1'
  const isOfficer = xmlText(xml, 'isOfficer') === '1'
  const insiderTitle =
    officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  const trades: InsiderTrade[] = []

  for (const block of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    if (xmlText(block, 'transactionCode') !== 'P') continue
    if (xmlValue(block, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(xmlValue(block, 'transactionShares') || '0')
    const price = parseFloat(xmlValue(block, 'transactionPricePerShare') || '0')
    const date = xmlValue(block, 'transactionDate') || fileDate

    if (shares <= 0 || price <= 0) continue

    trades.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      transactionDate: date,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      filingUrl,
    })
  }

  return trades
}

export async function fetchRecentInsiderPurchases(
  minValue = 100_000,
  pages = 6
): Promise<InsiderTrade[]> {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startdt = yesterday.toISOString().split('T')[0]
  const enddt = now.toISOString().split('T')[0]

  // Fetch multiple search pages in parallel
  const pageResults = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      fetch(
        `${EFTS}?q=%22%22&forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${i * 10}`,
        { headers: { 'User-Agent': USER_AGENT } }
      ).then(r => r.json())
    )
  )

  const seen = new Set<string>()
  const filings: Array<{ accessionNo: string; fileDate: string }> = []

  for (const r of pageResults) {
    if (r.status !== 'fulfilled') continue
    for (const hit of (r.value?.hits?.hits ?? []) as Array<{ _source: { accession_no: string; file_date: string } }>) {
      const no = hit._source?.accession_no
      const date = hit._source?.file_date ?? startdt
      if (no && !seen.has(no)) {
        seen.add(no)
        filings.push({ accessionNo: no, fileDate: date })
      }
    }
  }

  // Process in batches of 5 to stay within SEC rate limits
  const all: InsiderTrade[] = []
  for (let i = 0; i < filings.length; i += 5) {
    const batch = filings.slice(i, i + 5)
    const results = await Promise.allSettled(
      batch.map(f => processOneFiling(f.accessionNo, f.fileDate))
    )
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value)
    }
  }

  return all
    .filter(t => t.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue)
}
