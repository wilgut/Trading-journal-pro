import { NextResponse } from 'next/server'

const EDGAR_BASE = 'https://www.sec.gov'
const EFTS_BASE = 'https://efts.sec.gov'
// SEC requires a descriptive User-Agent identifying the app and contact
const USER_AGENT = 'TradingJournalPro/1.0 contact@tradingjournalpro.com'
const MIN_VALUE = 100_000
const MAX_FILINGS_TO_SCAN = 100
const BATCH_SIZE = 10

interface InsiderBuy {
  insiderName: string
  insiderTitle: string
  companyName: string
  ticker: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
}

// Extracts text from XML handling both flat <tag>val</tag>
// and nested <tag><value>val</value></tag> patterns used in Form 4
function extractVal(xml: string, tag: string): string {
  const flat = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i')
  const fm = xml.match(flat)
  if (fm) return fm[1].trim()

  const nested = new RegExp(`<${tag}[^>]*>\\s*<value>([^<]+)</value>`, 'is')
  const nm = xml.match(nested)
  if (nm) return nm[1].trim()

  return ''
}

function parseForm4(xml: string, filingUrl: string, fallbackEntity: string): InsiderBuy[] {
  const results: InsiderBuy[] = []

  const companyName = extractVal(xml, 'issuerName') || fallbackEntity
  const ticker = extractVal(xml, 'issuerTradingSymbol')
  const ownerName = extractVal(xml, 'rptOwnerName')

  const isDirector = extractVal(xml, 'isDirector') === '1'
  const isOfficer = extractVal(xml, 'isOfficer') === '1'
  const isTenPct = extractVal(xml, 'isTenPercentOwner') === '1'
  const officerTitle = extractVal(xml, 'officerTitle')

  // Skip pure 10%-owner positions (typically activist funds / institutions)
  // that hold no board or executive role — not an insider conviction signal
  if (!isDirector && !isOfficer && isTenPct) return results

  const title = isOfficer && officerTitle
    ? officerTitle
    : isDirector
    ? 'Director'
    : '10%+ Owner'

  const txnRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let m: RegExpExecArray | null

  while ((m = txnRe.exec(xml)) !== null) {
    const txn = m[1]

    // P = open-market purchase; A = acquired (vs D = disposed)
    if (extractVal(txn, 'transactionCode') !== 'P') continue
    if (extractVal(txn, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(extractVal(txn, 'transactionShares')) || 0
    const price = parseFloat(extractVal(txn, 'transactionPricePerShare')) || 0
    const total = shares * price
    if (total < MIN_VALUE) continue

    results.push({
      insiderName: ownerName,
      insiderTitle: title,
      companyName,
      ticker,
      shares,
      pricePerShare: price,
      totalValue: total,
      transactionDate: extractVal(txn, 'transactionDate'),
      filingUrl,
    })
  }

  return results
}

async function fetchFilingPage(startDate: string, endDate: string, from: number): Promise<any[]> {
  const url = new URL(`${EFTS_BASE}/LATEST/search-index`)
  url.searchParams.set('q', '"transactionCode"')  // all Form 4 XML contains this tag
  url.searchParams.set('forms', '4')
  url.searchParams.set('dateRange', 'custom')
  url.searchParams.set('startdt', startDate)
  url.searchParams.set('enddt', endDate)
  url.searchParams.set('from', String(from))

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`EDGAR EFTS error ${res.status}: ${url}`)

  const data = await res.json()
  return data.hits?.hits ?? []
}

async function fetchAndParse(hit: any): Promise<InsiderBuy[]> {
  const id: string = hit._id ?? ''
  if (!id) return []

  const xmlUrl = `${EDGAR_BASE}/Archives/${id}`
  try {
    const res = await fetch(xmlUrl, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return []
    const xml = await res.text()
    return parseForm4(xml, xmlUrl, hit._source?.entity_name ?? '')
  } catch {
    return []
  }
}

async function collectFilings(startDate: string, endDate: string): Promise<any[]> {
  const allHits: any[] = []
  // Paginate in increments of 10 (EFTS default page size)
  for (let from = 0; allHits.length < MAX_FILINGS_TO_SCAN; from += 10) {
    const page = await fetchFilingPage(startDate, endDate, from)
    if (page.length === 0) break
    allHits.push(...page)
    if (page.length < 10) break  // last page
  }
  return allHits.slice(0, MAX_FILINGS_TO_SCAN)
}

function fmt$(n: number, decimals = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n)
}

function buildSlackMessage(buys: InsiderBuy[], startDate: string, endDate: string, scanned: number): string {
  const lines: string[] = []
  lines.push(`*SEC EDGAR — Insider Purchases (${startDate} → ${endDate})*`)
  lines.push(`_Executives & directors buying their own stock • Min $${(MIN_VALUE / 1000).toFixed(0)}k • Ranked by value • ${scanned} Form 4 filings scanned_\n`)

  if (buys.length === 0) {
    lines.push('_No qualifying open-market purchases found for this period._')
    return lines.join('\n')
  }

  buys.slice(0, 20).forEach((b, i) => {
    const tickerLabel = b.ticker ? `$${b.ticker}` : b.companyName
    const sharesStr = new Intl.NumberFormat('en-US').format(Math.round(b.shares))
    lines.push(
      `*${i + 1}.* ${tickerLabel} — *${fmt$(b.totalValue)}*\n` +
      `   ${b.insiderName} _(${b.insiderTitle})_\n` +
      `   ${sharesStr} shares @ ${fmt$(b.pricePerShare, 2)} on ${b.transactionDate}`
    )
  })

  lines.push(`\n_${buys.length} qualifying purchase${buys.length !== 1 ? 's' : ''} found • Source: SEC EDGAR Form 4_`)
  return lines.join('\n')
}

async function postToSlack(message: string): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return { ok: false, error: 'SLACK_WEBHOOK_URL not configured' }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })

  return res.ok ? { ok: true } : { ok: false, error: `Slack responded ${res.status}` }
}

export async function GET() {
  const now = new Date()
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startDate = since.toISOString().split('T')[0]
  const endDate = now.toISOString().split('T')[0]

  const hits = await collectFilings(startDate, endDate)

  const allBuys: InsiderBuy[] = []
  for (let i = 0; i < hits.length; i += BATCH_SIZE) {
    const batch = hits.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(fetchAndParse))
    results.flat().forEach(b => allBuys.push(b))
  }

  allBuys.sort((a, b) => b.totalValue - a.totalValue)

  const message = buildSlackMessage(allBuys, startDate, endDate, hits.length)
  const slack = await postToSlack(message)

  return NextResponse.json({
    success: true,
    period: { start: startDate, end: endDate },
    filingsScanned: hits.length,
    qualifyingPurchases: allBuys.length,
    slackPosted: slack.ok,
    slackError: slack.error,
    message,
    topBuys: allBuys.slice(0, 20),
  })
}
