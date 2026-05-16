import { NextResponse } from 'next/server'

const EFTS_URL = 'https://efts.sec.gov/LATEST/search-index'
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data'
const MIN_PURCHASE_VALUE = 100_000
const PAGE_SIZE = 40
const BATCH_CONCURRENCY = 5

// SEC requires a descriptive User-Agent
const SEC_HEADERS: Record<string, string> = {
  'User-Agent': 'Trading-Journal-Pro compliance@trading-journal-pro.com',
  'Accept': 'application/json, text/html, application/xml, text/xml',
}

// ── Types ──────────────────────────────────────────────────────────────────

interface EftsHit {
  _source: {
    accession_no: string
    entity_name: string
    file_date: string
    display_names?: Array<{ name: string; id: string }>
  }
}

interface InsiderPurchase {
  insiderName: string
  insiderTitle: string
  companyName: string
  ticker: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingDate: string
  secUrl: string
}

// ── XML helpers ────────────────────────────────────────────────────────────

/** Return first text content of `<tag>…</tag>` (handles nested `<value>` wrapper). */
function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 's'))
  if (!m) return ''
  const inner = m[1].trim()
  // Many Form 4 fields wrap their value in <value>
  const val = inner.match(/<value>([^<]*)<\/value>/)
  return (val ? val[1] : inner).trim()
}

/** Return all content blocks matching `<tag>…</tag>`. */
function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g')
  return [...xml.matchAll(re)].map(m => m[1])
}

// ── EDGAR fetch helpers ────────────────────────────────────────────────────

async function safeFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: SEC_HEADERS,
      // Disable Next.js data cache so we always get fresh data
      cache: 'no-store',
    })
    return res.ok ? res.text() : null
  } catch {
    return null
  }
}

/**
 * Fetch the EDGAR directory listing for a filing and return the first .xml
 * filename that looks like a primary Form 4 document.
 */
async function getPrimaryXmlFilename(cik: string, accNoDashes: string): Promise<string | null> {
  const html = await safeFetch(`${ARCHIVES_BASE}/${cik}/${accNoDashes}/`)
  if (!html) return null

  const links = [...html.matchAll(/href="([^"]+\.xml)"/gi)]
    .map(m => m[1].toLowerCase())
    // Exclude XBRL taxonomy/label/calculation/presentation files
    .filter(f => !/_(lab|cal|def|pre|ref)\b/.test(f) && !f.includes('xsd'))

  return links[0] ?? null
}

// ── Form 4 parser ──────────────────────────────────────────────────────────

async function extractPurchases(hit: EftsHit): Promise<InsiderPurchase[]> {
  const { accession_no, entity_name, file_date } = hit._source
  const accNoDashes = accession_no.replace(/-/g, '')
  // The first 10-digit segment of the accession number IS the filer's CIK
  const cik = String(parseInt(accession_no.split('-')[0], 10))

  const xmlFilename = await getPrimaryXmlFilename(cik, accNoDashes)
  if (!xmlFilename) return []

  const xmlUrl = `${ARCHIVES_BASE}/${cik}/${accNoDashes}/${xmlFilename}`
  const xml = await safeFetch(xmlUrl)
  if (!xml) return []

  // ── Issuer (company) ──
  const issuerBlock = xml.match(/<issuer>([\s\S]*?)<\/issuer>/)?.[1] ?? ''
  const companyName = xmlTag(issuerBlock, 'issuerName') || entity_name
  const ticker = xmlTag(issuerBlock, 'issuerTradingSymbol')

  // ── Reporting owner (insider) ──
  const ownerBlock = xml.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/)?.[1] ?? ''
  const insiderName = xmlTag(ownerBlock, 'rptOwnerName')
  const insiderTitle =
    xmlTag(ownerBlock, 'officerTitle') ||
    (/<isDirector>\s*1/.test(ownerBlock) ? 'Director' :
     /<isOfficer>\s*1/.test(ownerBlock)  ? 'Officer'   :
     /<isTenPercentOwner>\s*1/.test(ownerBlock) ? '10% Owner' : 'Insider')

  const purchases: InsiderPurchase[] = []

  // ── Non-derivative transactions (ordinary stock) ──
  for (const tx of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const codingBlock  = tx.match(/<transactionCoding>([\s\S]*?)<\/transactionCoding>/)?.[1]  ?? ''
    const amountsBlock = tx.match(/<transactionAmounts>([\s\S]*?)<\/transactionAmounts>/)?.[1] ?? ''

    const txCode   = xmlTag(codingBlock, 'transactionCode')
    const acquired = xmlTag(amountsBlock.match(/<transactionAcquiredDisposedCode>([\s\S]*?)<\/transactionAcquiredDisposedCode>/)?.[1] ?? '', 'value')

    // P = open-market purchase, A = acquired
    if (txCode !== 'P' || acquired !== 'A') continue

    const shares = parseFloat(xmlTag(amountsBlock.match(/<transactionShares>([\s\S]*?)<\/transactionShares>/)?.[1] ?? '', 'value') || '0')
    const price  = parseFloat(xmlTag(amountsBlock.match(/<transactionPricePerShare>([\s\S]*?)<\/transactionPricePerShare>/)?.[1] ?? '', 'value') || '0')

    if (shares <= 0 || price <= 0) continue

    const totalValue = shares * price
    if (totalValue < MIN_PURCHASE_VALUE) continue

    const txDateBlock   = tx.match(/<transactionDate>([\s\S]*?)<\/transactionDate>/)?.[1] ?? ''
    const transactionDate = xmlTag(txDateBlock, 'value') || file_date

    purchases.push({
      insiderName,
      insiderTitle,
      companyName,
      ticker,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate,
      filingDate: file_date,
      secUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${xmlFilename}`,
    })
  }

  return purchases
}

// ── Concurrency limiter ────────────────────────────────────────────────────

async function processBatched<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
    // Respect SEC rate-limit guidance (~10 req/s) with a small pause between batches
    if (i + concurrency < items.length) {
      await new Promise(r => setTimeout(r, 350))
    }
  }
  return results
}

// ── Slack formatting ───────────────────────────────────────────────────────

const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    notation: 'compact', maximumFractionDigits: 1,
  }).format(n)

const usdFull = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

function buildSlackMessage(purchases: InsiderPurchase[], fromDate: string, toDate: string): string {
  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  const header = [
    `*:bank: Insider Buying Alert* — Last 24 h  _(as of ${ts} ET)_`,
    `_Open-market purchases >$100K by executives & directors  |  Ranked by value_`,
    `_Period checked: ${fromDate} → ${toDate}_`,
    '',
  ]

  if (purchases.length === 0) {
    return [...header, ':shrug: No qualifying open-market purchases found.'].join('\n')
  }

  const MEDALS = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:']
  const rows: string[] = []

  purchases.slice(0, 20).forEach((p, i) => {
    const rank   = MEDALS[i] ?? `*${i + 1}.*`
    const ticker = p.ticker ? ` ($${p.ticker})` : ''
    rows.push(
      `${rank} *${p.insiderName}*  (${p.insiderTitle})  →  *${usd(p.totalValue)}*`,
      `   ${p.companyName}${ticker}  |  ${num(p.shares)} shares @ ${usdFull(p.pricePerShare)}`,
      `   Filed ${p.filingDate}  ·  <${p.secUrl}|SEC Filing>`,
      '',
    )
  })

  const footer = purchases.length > 20
    ? [`_…and ${purchases.length - 20} more qualifying purchase(s)_`, '']
    : []

  return [...header, ...rows, ...footer, `_Total qualifying filings: *${purchases.length}*_`].join('\n')
}

// ── Slack delivery ─────────────────────────────────────────────────────────

async function postToSlack(message: string): Promise<{ ok: boolean; method: string }> {
  // Prefer a bot token + channel ID (richer formatting, pinnable)
  const botToken = process.env.SLACK_BOT_TOKEN
  const channelId = process.env.SLACK_CHANNEL_ID

  if (botToken && channelId) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: channelId, text: message, mrkdwn: true }),
    })
    const data: { ok: boolean } = await res.json()
    return { ok: data.ok, method: 'bot-token' }
  }

  // Fall back to Incoming Webhook
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    })
    return { ok: res.ok, method: 'webhook' }
  }

  return { ok: false, method: 'none' }
}

// ── Route handler ──────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // seconds (Vercel Pro / hobby limit)

export async function GET() {
  try {
    const now       = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const startdt   = yesterday.toISOString().split('T')[0]
    const enddt     = now.toISOString().split('T')[0]

    // ── 1. Fetch recent Form 4 filings from EDGAR EFTS ──
    const searchUrl =
      `${EFTS_URL}?forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}` +
      `&from=0&size=${PAGE_SIZE}`

    const searchRes = await fetch(searchUrl, {
      headers: SEC_HEADERS,
      cache: 'no-store',
    })

    if (!searchRes.ok) {
      return NextResponse.json(
        { error: 'EDGAR search request failed', status: searchRes.status },
        { status: 502 },
      )
    }

    const searchData: { hits?: { hits?: EftsHit[] } } = await searchRes.json()
    const hits = searchData.hits?.hits ?? []

    // ── 2. Extract purchases from each filing (rate-limited batches) ──
    const nested = await processBatched(hits, extractPurchases, BATCH_CONCURRENCY)
    const allPurchases = nested.flat()

    // ── 3. Sort descending by total value ──
    allPurchases.sort((a, b) => b.totalValue - a.totalValue)

    // ── 4. Send to Slack ──
    const message = buildSlackMessage(allPurchases, startdt, enddt)
    const slack   = await postToSlack(message)

    return NextResponse.json({
      period: { from: startdt, to: enddt },
      filingsChecked: hits.length,
      qualifyingPurchases: allPurchases.length,
      slackDelivery: slack,
      purchases: allPurchases,
    })
  } catch (err) {
    console.error('[insider-buys] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
