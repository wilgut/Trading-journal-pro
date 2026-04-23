import { NextResponse } from 'next/server'

// Use Node.js runtime for longer timeout (no 10s Edge limit)
export const runtime = 'nodejs'

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'
const MIN_PURCHASE_VALUE = 100_000
const BATCH_SIZE = 5
const MAX_FILINGS = 80
const INTER_BATCH_DELAY_MS = 150

// SEC requires a descriptive User-Agent with contact info
const SEC_HEADERS = {
  'User-Agent': 'Trading-Journal-Pro admin@tradingjournalpro.com',
  Accept: 'application/json',
}

interface InsiderBuy {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
  accession: string
}

// -------------------------------------------------------------------
// XML helpers (no external deps — Form 4 XML is simple enough)
// -------------------------------------------------------------------

function xmlDirect(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
  return m ? m[1].trim() : ''
}

// Many Form 4 fields are wrapped: <tag><value>X</value></tag>
function xmlValue(xml: string, tag: string): string {
  const inner = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!inner) return ''
  const val = inner[1].match(/<value>([^<]*)<\/value>/)
  if (val) return val[1].trim()
  return inner[1].replace(/<[^>]*>/g, '').trim()
}

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[0])
  return out
}

// -------------------------------------------------------------------
// EDGAR fetching
// -------------------------------------------------------------------

async function safeFetch(url: string, extraHeaders: Record<string, string> = {}): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { ...SEC_HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok ? res : null
  } catch {
    return null
  }
}

async function resolveXmlUrl(cik: string, accNoDashes: string): Promise<string | null> {
  // Primary guess: accession number is also the XML filename
  const directUrl = `${EDGAR_ARCHIVES}/${cik}/${accNoDashes}/${accNoDashes}.xml`
  const direct = await safeFetch(directUrl, { Accept: 'application/xml, text/xml, */*' })
  if (direct) return directUrl

  // Fallback: read filing index to locate the Form 4 XML document
  const indexUrl = `${EDGAR_ARCHIVES}/${cik}/${accNoDashes}/index.json`
  const indexRes = await safeFetch(indexUrl)
  if (!indexRes) return null

  try {
    const idx = await indexRes.json() as { directory?: { item?: Array<{ name: string; type: string }> } }
    const items = idx.directory?.item ?? []
    const xmlItem = items.find(i => i.type === '4' || (i.name?.endsWith('.xml') && !i.name.includes('xsl')))
    if (!xmlItem) return null
    return `${EDGAR_ARCHIVES}/${cik}/${accNoDashes}/${xmlItem.name}`
  } catch {
    return null
  }
}

async function parseForm4(accessionWithDashes: string): Promise<InsiderBuy[]> {
  // CIK is the first segment of the accession number (strip leading zeros)
  const cikPadded = accessionWithDashes.split('-')[0]
  const cik = String(parseInt(cikPadded, 10))
  const accNoDashes = accessionWithDashes.replace(/-/g, '')

  const xmlUrl = await resolveXmlUrl(cik, accNoDashes)
  if (!xmlUrl) return []

  const xmlRes = await safeFetch(xmlUrl, { Accept: 'application/xml, text/xml, */*' })
  if (!xmlRes) return []

  let xml: string
  try {
    xml = await xmlRes.text()
  } catch {
    return []
  }

  if (!xml.includes('ownershipDocument')) return []

  // Issuer details
  const companyName = xmlDirect(xml, 'issuerName')
  const ticker = xmlDirect(xml, 'issuerTradingSymbol').toUpperCase()

  // Reporting owner
  const insiderName = xmlDirect(xml, 'rptOwnerName')
  const isOfficer = xmlDirect(xml, 'isOfficer') === '1'
  const isDirector = xmlDirect(xml, 'isDirector') === '1'
  if (!isOfficer && !isDirector) return [] // skip non-exec/director filers
  const officerTitle = xmlDirect(xml, 'officerTitle')
  const insiderTitle = officerTitle || (isDirector ? 'Director' : 'Executive')

  const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/`

  // Parse non-derivative transactions (direct open-market stock purchases)
  const txBlocks = xmlBlocks(xml, 'nonDerivativeTransaction')
  const buys: InsiderBuy[] = []

  for (const tx of txBlocks) {
    const code = xmlDirect(tx, 'transactionCode')
    if (code !== 'P') continue // P = open-market purchase

    const shares = parseFloat(xmlValue(tx, 'transactionShares') || '0')
    const price = parseFloat(xmlValue(tx, 'transactionPricePerShare') || '0')

    if (shares <= 0 || price <= 0) continue
    const totalValue = shares * price
    if (totalValue < MIN_PURCHASE_VALUE) continue

    buys.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate: xmlValue(tx, 'transactionDate'),
      filingUrl,
      accession: accessionWithDashes,
    })
  }

  return buys
}

// -------------------------------------------------------------------
// Batch concurrency helper
// -------------------------------------------------------------------

async function runBatched<T, R>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<R[]>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    batchResults.forEach(r => results.push(...r))
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  return results
}

// -------------------------------------------------------------------
// Slack reporting
// -------------------------------------------------------------------

function formatCurrency(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`
  return `$${(val / 1_000).toFixed(0)}K`
}

function buildSlackMessage(buys: InsiderBuy[], dateRange: { from: string; to: string }): string {
  const header = `*SEC Insider Buys — ${dateRange.from} to ${dateRange.to}*\n*Executives & directors purchasing their own stock | Purchases >$100K | Ranked by value*`

  if (buys.length === 0) {
    return `${header}\n\n_No qualifying insider purchases found in the last 24 hours._`
  }

  const medals = ['🥇', '🥈', '🥉']
  const rows = buys.map((b, i) => {
    const rank = medals[i] ?? `${i + 1}.`
    const value = formatCurrency(b.totalValue)
    const shares = b.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })
    const price = b.pricePerShare.toFixed(2)
    return [
      `${rank} *${b.ticker || '—'}* — ${b.companyName}`,
      `   👤 ${b.insiderName} _(${b.insiderTitle})_`,
      `   💰 ${value} — ${shares} shares @ $${price}`,
      `   📅 ${b.transactionDate} | <${b.filingUrl}|View Filing>`,
    ].join('\n')
  })

  return `${header}\n\n${rows.join('\n\n')}\n\n_${buys.length} purchase${buys.length !== 1 ? 's' : ''} found_`
}

async function sendSlack(message: string): Promise<{ ok: boolean; error?: string }> {
  const webhook = process.env.SLACK_WEBHOOK_URL
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL ?? '#trading-alerts'

  if (webhook) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    })
    return { ok: res.ok, error: res.ok ? undefined : await res.text() }
  }

  if (token) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text: message }),
    })
    const json = await res.json() as { ok: boolean; error?: string }
    return json
  }

  return { ok: false, error: 'No SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN configured' }
}

// -------------------------------------------------------------------
// Route handler
// -------------------------------------------------------------------

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const postToSlack = searchParams.get('slack') !== 'false'
  const minValue = Number(searchParams.get('min') ?? MIN_PURCHASE_VALUE)

  // Last 24 hours
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startdt = yesterday.toISOString().split('T')[0]
  const enddt = now.toISOString().split('T')[0]

  // 1. Query EDGAR full-text search for recent Form 4 filings
  const searchUrl =
    `${EDGAR_SEARCH}?forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}`

  const searchRes = await safeFetch(searchUrl)
  if (!searchRes) {
    return NextResponse.json({ error: 'Failed to reach SEC EDGAR' }, { status: 502 })
  }

  let searchData: { hits?: { hits?: Array<{ _id: string }> } }
  try {
    searchData = await searchRes.json()
  } catch {
    return NextResponse.json({ error: 'Invalid response from SEC EDGAR' }, { status: 502 })
  }

  const hits = (searchData.hits?.hits ?? []).slice(0, MAX_FILINGS)

  if (hits.length === 0) {
    const msg = buildSlackMessage([], { from: startdt, to: enddt })
    const slackResult = postToSlack ? await sendSlack(msg) : null
    return NextResponse.json({ dateRange: { from: startdt, to: enddt }, count: 0, buys: [], slackResult })
  }

  // 2. Fetch and parse each Form 4 XML concurrently in batches
  const accessions = hits.map(h => h._id)
  const allBuys = await runBatched(accessions, BATCH_SIZE, INTER_BATCH_DELAY_MS, parseForm4)

  // 3. Filter by minimum value and rank by total value descending
  const ranked = allBuys
    .filter(b => b.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue)

  // 4. Send Slack summary
  const message = buildSlackMessage(ranked, { from: startdt, to: enddt })
  const slackResult = postToSlack ? await sendSlack(message) : null

  return NextResponse.json({
    dateRange: { from: startdt, to: enddt },
    filingsFetched: hits.length,
    count: ranked.length,
    buys: ranked,
    slackResult,
  })
}
