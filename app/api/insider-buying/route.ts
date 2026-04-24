import { NextResponse } from 'next/server'

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'
const MIN_VALUE_USD = 100_000
const USER_AGENT = 'TradingJournalPro/1.0 admin@tradingjournalpro.com'
// EDGAR rate limit: 10 req/sec — stay comfortably under it
const RATE_LIMIT_MS = 120

export interface InsiderPurchase {
  company: string
  ticker: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingDate: string
  accessionNumber: string
}

// ── XML helpers ────────────────────────────────────────────────────────────────

/** Extract first occurrence of <tag><value>X</value></tag> or <tag>X</tag> */
function xmlVal(xml: string, tag: string): string {
  // Handles EDGAR's common <tag><value>X</value></tag> wrapper
  let m = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<value>([^<]*)</value>`, 'i'))
  if (m) return m[1].trim()
  // Fallback: direct text content
  m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

/** Return all non-overlapping blocks matching <tag>…</tag> */
function xmlBlocks(xml: string, tag: string): string[] {
  const results: string[] = []
  const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) results.push(m[0])
  return results
}

/** Return first block matching <tag>…</tag> */
function xmlBlock(xml: string, tag: string): string {
  return xmlBlocks(xml, tag)[0] ?? ''
}

// ── EDGAR helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

/** The accession number's leading segment is the filer's CIK. */
function cikFromAccession(accession: string): string {
  return accession.split('-')[0].replace(/^0+/, '') || '0'
}

function nodashAccession(accession: string): string {
  return accession.replace(/-/g, '')
}

async function fetchWithUA(url: string): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
}

/**
 * Locate and return the Form 4 XML text for a given filing.
 * Strategy: fetch the EDGAR JSON index to find the .xml filename, then download it.
 */
async function fetchForm4XML(cik: string, accession: string): Promise<string | null> {
  const nodash = nodashAccession(accession)
  const base = `${EDGAR_ARCHIVES}/${cik}/${nodash}`

  // Attempt 1: JSON index → find the xml file
  try {
    const indexRes = await fetchWithUA(`${base}/index.json`)
    if (indexRes.ok) {
      const idx = await indexRes.json()
      const items: Array<{ name: string }> = idx.directory?.item ?? []
      // Pick the first .xml that is not a schema/stylesheet
      const xmlFile = items.find(
        f => f.name.endsWith('.xml') && !/\.(xsd|xsl)/.test(f.name)
      )
      if (xmlFile) {
        const xmlRes = await fetchWithUA(`${base}/${xmlFile.name}`)
        if (xmlRes.ok) return xmlRes.text()
      }
    }
  } catch {
    // fall through
  }

  // Attempt 2: predictable name pattern used by many filers
  for (const name of [`${accession}.xml`, 'form4.xml', 'wf-form4.xml']) {
    try {
      const res = await fetchWithUA(`${base}/${name}`)
      if (res.ok) return res.text()
    } catch {
      // try next
    }
  }

  return null
}

// ── Form 4 parser ──────────────────────────────────────────────────────────────

function parseForm4(xml: string, filingDate: string, accession: string): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = []

  const issuerBlock = xmlBlock(xml, 'issuer')
  const company = xmlVal(issuerBlock, 'issuerName') || xmlVal(xml, 'issuerName')
  const ticker = xmlVal(issuerBlock, 'issuerTradingSymbol') || xmlVal(xml, 'issuerTradingSymbol')

  const ownerBlock = xmlBlock(xml, 'reportingOwner')
  const insiderName = xmlVal(ownerBlock, 'rptOwnerName') || xmlVal(xml, 'rptOwnerName')
  const relBlock = xmlBlock(xml, 'reportingOwnerRelationship')

  const isDirector = xmlVal(relBlock, 'isDirector') === '1'
  const isOfficer = xmlVal(relBlock, 'isOfficer') === '1'
  // Skip if not an executive or director
  if (!isDirector && !isOfficer) return purchases

  const officerTitle = xmlVal(relBlock, 'officerTitle')
  const insiderTitle = isOfficer && officerTitle
    ? officerTitle
    : isDirector
    ? 'Director'
    : 'Insider'

  for (const tx of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const code = xmlVal(xmlBlock(tx, 'transactionCoding'), 'transactionCode')
      || xmlVal(tx, 'transactionCode')
    const adCode = xmlVal(tx, 'transactionAcquiredDisposedCode')

    // Only open-market purchases (P) that are acquisitions (A)
    if (code !== 'P' || adCode !== 'A') continue

    const shares = parseFloat(xmlVal(tx, 'transactionShares') || '0')
    const price = parseFloat(xmlVal(tx, 'transactionPricePerShare') || '0')
    if (!shares || !price) continue

    const totalValue = shares * price
    if (totalValue < MIN_VALUE_USD) continue

    purchases.push({
      company: company || 'Unknown Company',
      ticker: ticker || '',
      insiderName: insiderName || 'Unknown',
      insiderTitle,
      shares,
      pricePerShare: price,
      totalValue,
      filingDate,
      accessionNumber: accession,
    })
  }

  return purchases
}

// ── Slack notification ─────────────────────────────────────────────────────────

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

async function sendSlackSummary(
  purchases: InsiderPurchase[],
  dateRange: { from: string; to: string },
  processedCount: number
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return

  const lines: string[] = [
    '*📈 Insider Buying Alert — Last 24 Hours*',
    `_Open-market purchases >$100K by executives & directors_`,
    `_Filings processed: ${processedCount} | Window: ${dateRange.from} → ${dateRange.to}_`,
    '',
  ]

  if (purchases.length === 0) {
    lines.push('No significant insider purchases found in this window.')
  } else {
    purchases.forEach((p, i) => {
      const co = p.ticker ? `${p.company} (${p.ticker})` : p.company
      lines.push(
        `*${i + 1}. ${co}* — ${p.insiderName}, _${p.insiderTitle}_`,
        `   ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${formatMoney(p.totalValue)}*`,
        `   Filed: ${p.filingDate}`,
        ''
      )
    })
  }

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  })
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET() {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startDate = yesterday.toISOString().split('T')[0]
  const endDate = now.toISOString().split('T')[0]

  // Page through up to 100 Form 4 filings filed in the last 24 hours
  const searchUrl =
    `${EDGAR_SEARCH}?forms=4&dateRange=custom` +
    `&startdt=${startDate}&enddt=${endDate}&from=0&size=100`

  let filings: Array<{ _id: string; _source: { file_date: string } }> = []
  try {
    const res = await fetchWithUA(searchUrl)
    if (!res.ok) throw new Error(`EDGAR search HTTP ${res.status}`)
    const data = await res.json()
    filings = data.hits?.hits ?? []
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 })
  }

  const allPurchases: InsiderPurchase[] = []

  for (const filing of filings) {
    const accession = filing._id
    const filingDate = filing._source.file_date
    const cik = cikFromAccession(accession)

    await sleep(RATE_LIMIT_MS)

    try {
      const xml = await fetchForm4XML(cik, accession)
      if (!xml) continue
      allPurchases.push(...parseForm4(xml, filingDate, accession))
    } catch {
      // Skip individual filing errors — don't abort the whole run
    }
  }

  // Rank by total value, largest first
  const ranked = allPurchases
    .filter(p => p.totalValue >= MIN_VALUE_USD)
    .sort((a, b) => b.totalValue - a.totalValue)

  await sendSlackSummary(ranked, { from: startDate, to: endDate }, filings.length)

  return NextResponse.json({
    generatedAt: now.toISOString(),
    dateRange: { from: startDate, to: endDate },
    totalFilingsProcessed: filings.length,
    significantPurchases: ranked.length,
    purchases: ranked,
  })
}
