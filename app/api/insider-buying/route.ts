import { NextResponse } from 'next/server'

// SEC EDGAR requires a descriptive User-Agent per their developer guidelines
const EDGAR_UA = `Trading-Journal-Pro ${process.env.CONTACT_EMAIL ?? 'contact@example.com'}`

export interface InsiderPurchase {
  companyName: string
  ticker: string
  insiderName: string
  role: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingDate: string
  accessionNo: string
  edgarUrl: string
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toISODate(d)
}

// ── EDGAR fetch (enforces User-Agent and no-cache) ───────────────────────────

async function edgarFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': EDGAR_UA, 'Accept-Encoding': 'gzip, deflate' },
    next: { revalidate: 0 },
  })
}

// ── Step 1: search EFTS for recent Form 4 filing accession numbers ───────────

interface EftshHit {
  _source: {
    accession_no: string
    file_date: string
    entity_name?: string
  }
}

async function searchForm4Filings(startDate: string, endDate: string): Promise<EftshHit[]> {
  const base =
    `https://efts.sec.gov/LATEST/search-index?forms=4` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}`

  const allHits: EftshHit[] = []
  let from = 0
  const pageSize = 40

  // Paginate up to 500 filings (safety cap to stay within EDGAR rate limits)
  while (from < 500) {
    const url = `${base}&hits.hits.from=${from}&hits.hits.total.value=true`
    const res = await edgarFetch(url)
    if (!res.ok) break

    const json = await res.json()
    const hits: EftshHit[] = json?.hits?.hits ?? []
    if (hits.length === 0) break

    allHits.push(...hits)
    from += hits.length

    const total: number = json?.hits?.total?.value ?? 0
    if (from >= total) break

    // Respect EDGAR's 10 req/sec guideline
    await new Promise((r) => setTimeout(r, 110))
  }

  return allHits
}

// ── Step 2: derive the filer CIK from the accession number ──────────────────
// Accession format: XXXXXXXXXX-YY-ZZZZZZ  (first 10 digits = filer CIK)

function cikFromAccession(accessionNo: string): string {
  return String(parseInt(accessionNo.split('-')[0], 10))
}

// ── Step 3: fetch the Form 4 XML ─────────────────────────────────────────────

async function fetchForm4Xml(cik: string, accessionNo: string): Promise<string | null> {
  const noHyphens = accessionNo.replace(/-/g, '')
  // Primary doc is almost always named {accession-no}.xml
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${noHyphens}/${accessionNo}.xml`
  try {
    const res = await edgarFetch(url)
    if (res.ok) return await res.text()
  } catch {
    // fall through
  }

  // Fallback: get the filing index to find the primary document name
  try {
    const idxRes = await edgarFetch(
      `https://www.sec.gov/Archives/edgar/data/${cik}/${noHyphens}/`
    )
    if (!idxRes.ok) return null
    const html = await idxRes.text()
    const match = html.match(/href="([^"]+\.xml)"/)
    if (!match) return null
    const xmlRes = await edgarFetch(
      `https://www.sec.gov/Archives/edgar/data/${cik}/${noHyphens}/${match[1]}`
    )
    if (xmlRes.ok) return await xmlRes.text()
  } catch {
    // fall through
  }

  return null
}

// ── Step 4: parse Form 4 XML ─────────────────────────────────────────────────

function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function xmlVal(xml: string, tag: string): string {
  // Handles <tag><value>...</value></tag> pattern common in Form 4
  const m = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<value>([^<]*)</value>`, 'i'))
  return m ? m[1].trim() : ''
}

function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi')
  return xml.match(re) ?? []
}

function parseForm4(xml: string, filingDate: string, accessionNo: string, cik: string): InsiderPurchase[] {
  const issuerName = xmlTag(xml, 'issuerName')
  const ticker = xmlTag(xml, 'issuerTradingSymbol').toUpperCase()
  const insiderName = xmlTag(xml, 'rptOwnerName')

  const isDirector = xmlTag(xml, 'isDirector') === '1'
  const isOfficer = xmlTag(xml, 'isOfficer') === '1'
  const officerTitle = xmlTag(xml, 'officerTitle')
  const role =
    isOfficer && officerTitle ? officerTitle :
    isDirector ? 'Director' :
    isOfficer ? 'Officer' : 'Insider'

  const noHyphens = accessionNo.replace(/-/g, '')
  const edgarUrl =
    `https://www.sec.gov/Archives/edgar/data/${cik}/${noHyphens}/${accessionNo}.xml`

  const purchases: InsiderPurchase[] = []

  for (const block of extractBlocks(xml, 'nonDerivativeTransaction')) {
    // Must be a purchase (code P) where shares are acquired (A)
    if (xmlTag(block, 'transactionCode') !== 'P') continue
    if (xmlVal(block, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(xmlVal(block, 'transactionShares'))
    const price = parseFloat(xmlVal(block, 'transactionPricePerShare'))
    if (!shares || !price || isNaN(shares) || isNaN(price)) continue

    purchases.push({
      companyName: issuerName,
      ticker,
      insiderName,
      role,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      transactionDate: xmlVal(block, 'transactionDate'),
      filingDate,
      accessionNo,
      edgarUrl,
    })
  }

  return purchases
}

// ── Step 5: rate-limited batch processing ────────────────────────────────────

async function inBatches<T, R>(
  items: T[],
  size: number,
  delayMs: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const batch = await Promise.all(items.slice(i, i + size).map(fn))
    results.push(...batch)
    if (i + size < items.length) await new Promise((r) => setTimeout(r, delayMs))
  }
  return results
}

// ── Step 6: Slack message formatter ──────────────────────────────────────────

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function buildSlackMessage(purchases: InsiderPurchase[], startDate: string, endDate: string): string {
  const total = purchases.reduce((s, p) => s + p.totalValue, 0)
  const top = purchases.slice(0, 20)

  const rows = top
    .map((p, i) => {
      const rank = String(i + 1).padStart(2, ' ')
      const label = p.ticker || p.companyName
      return (
        `${rank}. *${label}* — ${p.insiderName} _(${p.role})_\n` +
        `     ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${fmtCurrency(p.totalValue)}*  |  txn ${p.transactionDate}`
      )
    })
    .join('\n')

  const moreNote = purchases.length > 20 ? `\n_…and ${purchases.length - 20} more_` : ''

  return [
    `🐋 *SEC Insider Open-Market Buys >$100K* | ${startDate} → ${endDate}`,
    `_${purchases.length} qualifying transaction${purchases.length !== 1 ? 's' : ''} · Total value: *${fmtCurrency(total)}*_`,
    '',
    rows,
    moreNote,
    '',
    `_Source: SEC EDGAR Form 4 · <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40|View all Form 4s>_`,
  ].join('\n')
}

// ── Step 7: post to Slack ─────────────────────────────────────────────────────

async function postToSlack(channelId: string, text: string): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN not set' }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
  })

  const json = await res.json()
  return { ok: json.ok, ts: json.ts, error: json.error }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const minValue = Number(searchParams.get('minValue') ?? 100_000)
  const hoursBack = Number(searchParams.get('hours') ?? 24)
  const sendSlack = searchParams.get('slack') === 'true'
  const slackChannel = searchParams.get('channel') ?? process.env.SLACK_CHANNEL_ID ?? ''

  const endDate = toISODate(new Date())
  const startDate = daysAgo(Math.ceil(hoursBack / 24))

  // 1. Discover all Form 4 filings filed in the window
  const filingHits = await searchForm4Filings(startDate, endDate)

  // 2. Fetch + parse each filing (5 concurrent, 200 ms between batches ≈ 5 req/s)
  const rawPurchases = (
    await inBatches(filingHits, 5, 200, async (hit) => {
      const accessionNo: string = hit._source?.accession_no ?? ''
      const filingDate: string = hit._source?.file_date ?? ''
      if (!accessionNo) return []

      const cik = cikFromAccession(accessionNo)
      const xml = await fetchForm4Xml(cik, accessionNo)
      if (!xml) return []

      return parseForm4(xml, filingDate, accessionNo, cik)
    })
  ).flat()

  // 3. Filter for purchases above the minimum and rank by size
  const purchases = rawPurchases
    .filter((p) => p.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue)

  // 4. Optionally post to Slack
  let slackResult: { ok: boolean; ts?: string; error?: string } | null = null
  if (sendSlack && slackChannel) {
    const message = buildSlackMessage(purchases, startDate, endDate)
    slackResult = await postToSlack(slackChannel, message)
  }

  return NextResponse.json({
    window: { startDate, endDate, hoursBack },
    count: purchases.length,
    totalValue: purchases.reduce((s, p) => s + p.totalValue, 0),
    purchases,
    slackResult,
  })
}
