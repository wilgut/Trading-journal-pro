import { NextResponse } from 'next/server'

const EDGAR_BASE = 'https://www.sec.gov'
const EDGAR_EFTS  = 'https://efts.sec.gov/LATEST/search-index'
const SLACK_API   = 'https://slack.com/api/chat.postMessage'
const MIN_VALUE   = 100_000
const MAX_PAGES   = 5          // 10 results/page → up to 50 filings fetched
const BATCH_SIZE  = 10         // parallel XML fetches per batch
const USER_AGENT  = 'TradingJournalPro wilgut@trading-journal-pro.com'

interface Purchase {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
}

// ─── XML helpers (no external parser dependency) ────────────────────────────

function extractTag(xml: string, tag: string): string {
  // handles both <tag><value>X</value></tag> and plain <tag>X</tag>
  const valueRe = new RegExp(`<${tag}[^>]*>\\s*<value>([^<]+)</value>`, 's')
  const directRe = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 's')
  return (xml.match(valueRe) ?? xml.match(directRe))?.[1]?.trim() ?? ''
}

function extractBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = []
  let rest = xml
  while (true) {
    const start = rest.indexOf(`<${tag}`)
    if (start === -1) break
    const end = rest.indexOf(`</${tag}>`, start)
    if (end === -1) break
    blocks.push(rest.slice(start, end + tag.length + 3))
    rest = rest.slice(end + tag.length + 3)
  }
  return blocks
}

// ─── EDGAR helpers ──────────────────────────────────────────────────────────

function cikFromAccession(accNo: string): string {
  // accNo format: 0000950170-25-062543 → first 10 digits = filer CIK
  return String(parseInt(accNo.replace(/-/g, '').slice(0, 10), 10))
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok ? res.text() : null
  } catch {
    return null
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

// Returns accession numbers filed in [startDate, endDate]
async function getAccessionNumbers(startDate: string, endDate: string): Promise<string[]> {
  const accNos: string[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      forms: '4',
      dateRange: 'custom',
      startdt: startDate,
      enddt: endDate,
      from: String(page * 10),
    })
    const data = await fetchJson(`${EDGAR_EFTS}?${params}`) as {
      hits?: { hits?: Array<{ _id: string }> }
    } | null
    const hits = data?.hits?.hits ?? []
    if (hits.length === 0) break
    for (const hit of hits) accNos.push(hit._id)
  }

  return accNos
}

async function getXmlUrl(cik: string, accNo: string): Promise<string | null> {
  const accNoDashes = accNo.replace(/-/g, '')
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accNo}-index.json`
  const index = await fetchJson(indexUrl) as {
    directory?: { item?: Array<{ name: string; type: string }> }
  } | null

  const items = index?.directory?.item ?? []
  // prefer a document explicitly typed '4' or the first .xml that isn't a stylesheet/label
  const xmlDoc =
    items.find(f => f.type === '4' && f.name.endsWith('.xml')) ??
    items.find(f => f.name.endsWith('.xml') && !/label|cal|def|pre|r\d/i.test(f.name))

  return xmlDoc
    ? `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${xmlDoc.name}`
    : null
}

async function parsePurchases(accNo: string): Promise<Purchase[]> {
  const cik = cikFromAccession(accNo)
  const accNoDashes = accNo.replace(/-/g, '')
  const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${accNo}-index.htm`

  const xmlUrl = await getXmlUrl(cik, accNo)
  if (!xmlUrl) return []

  const xml = await fetchText(xmlUrl)
  if (!xml) return []

  const companyName   = extractTag(xml, 'issuerName')      || 'Unknown'
  const ticker        = extractTag(xml, 'issuerTradingSymbol')
  const insiderName   = extractTag(xml, 'rptOwnerName')    || 'Unknown'
  const officerTitle  = extractTag(xml, 'officerTitle')
  const isDirector    = extractTag(xml, 'isDirector') === '1'
  const isOfficer     = extractTag(xml, 'isOfficer') === '1'
  const is10Pct       = extractTag(xml, 'isTenPercentOwner') === '1'

  const insiderTitle =
    officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : is10Pct ? '10% Owner' : 'Insider')

  const purchases: Purchase[] = []

  for (const block of extractBlocks(xml, 'nonDerivativeTransaction')) {
    if (extractTag(block, 'transactionCode') !== 'P') continue

    const shares = parseFloat(extractTag(block, 'transactionShares') || '0')
    const price  = parseFloat(extractTag(block, 'transactionPricePerShare') || '0')
    const date   = extractTag(block, 'transactionDate')

    if (shares <= 0 || price <= 0) continue
    const totalValue = shares * price
    if (totalValue < MIN_VALUE) continue

    purchases.push({ companyName, ticker, insiderName, insiderTitle, shares, pricePerShare: price, totalValue, transactionDate: date, filingUrl })
  }

  return purchases
}

// ─── Slack formatting ────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  return `$${Math.round(n / 1_000)}K`
}

function buildSlackMessage(purchases: Purchase[], dateRange: string): string {
  const header = `*SEC EDGAR Insider Purchases — ${dateRange}*\n_Open-market buys >$100K · ranked by size_`

  if (purchases.length === 0) {
    return `${header}\n\nNo significant insider purchases found in this window.`
  }

  const ranked = [...purchases].sort((a, b) => b.totalValue - a.totalValue)
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:']

  const lines = ranked.slice(0, 20).map((p, i) => {
    const rank    = medals[i] ?? `*${i + 1}.*`
    const company = p.ticker ? `${p.companyName} *(${p.ticker})*` : `*${p.companyName}*`
    const shares  = p.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })
    return (
      `${rank} ${fmt(p.totalValue)} — ${company}\n` +
      `   ${p.insiderName} _(${p.insiderTitle})_ · ${shares} sh @ $${p.pricePerShare.toFixed(2)} · ${p.transactionDate}\n` +
      `   <${p.filingUrl}|View SEC Filing>`
    )
  })

  const footer = ranked.length > 20 ? `\n_…and ${ranked.length - 20} more purchases_` : ''
  return `${header}\n\n${lines.join('\n\n')}${footer}`
}

async function sendSlack(message: string): Promise<void> {
  const token   = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL_ID ?? 'C0ATEAY4P6H'

  if (!token) {
    console.warn('[insider-purchases] SLACK_BOT_TOKEN not set — skipping Slack post')
    return
  }

  const res = await fetch(SLACK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text: message, mrkdwn: true }),
  })
  const json = await res.json() as { ok: boolean; error?: string }
  if (!json.ok) console.error('[insider-purchases] Slack error:', json.error)
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const skipSlack = searchParams.get('skip_slack') === 'true'

  // 24-hour window
  const now       = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startDate = yesterday.toISOString().slice(0, 10)
  const endDate   = now.toISOString().slice(0, 10)
  const dateRange = startDate === endDate ? startDate : `${startDate} → ${endDate}`

  // 1. Get accession numbers from EDGAR EFTS
  const accNos = await getAccessionNumbers(startDate, endDate)

  // 2. Fetch & parse Form 4 XMLs in parallel batches
  const allPurchases: Purchase[] = []
  for (let i = 0; i < accNos.length; i += BATCH_SIZE) {
    const batch   = accNos.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(parsePurchases))
    allPurchases.push(...results.flat())
  }

  // 3. Rank and deduplicate (same insider+company may file multiple transactions)
  const ranked = allPurchases.sort((a, b) => b.totalValue - a.totalValue)

  // 4. Build Slack message and send
  const message = buildSlackMessage(ranked, dateRange)
  if (!skipSlack) await sendSlack(message)

  return NextResponse.json({
    success: true,
    dateRange,
    filingsChecked: accNos.length,
    purchasesFound: ranked.length,
    slackSent: !skipSlack,
    purchases: ranked,
    slackMessage: message,
  })
}
