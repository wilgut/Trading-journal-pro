/**
 * SEC EDGAR Form 4 insider-purchase scanner.
 *
 * Fetches all Form 4 filings from the last 24 h, parses each XML document,
 * keeps only open-market purchases (transaction code "P") worth more than
 * MIN_PURCHASE_VALUE, and returns them sorted by total value descending.
 *
 * SEC Fair-Access Policy: max 10 req/s with a descriptive User-Agent.
 */

import { subDays, format } from 'date-fns'

// ─── constants ───────────────────────────────────────────────────────────────

const EDGAR_ARCHIVE = 'https://www.sec.gov/Archives/edgar/data'
const EFTS_SEARCH   = 'https://efts.sec.gov/LATEST/search-index'
const EFTS_PAGE     = 10   // EFTS default page size
const MAX_FILINGS   = 300  // daily cap to stay within rate limits
const BATCH_SIZE    = 5    // concurrent EDGAR requests per tick
const TICK_MS       = 600  // pause between batches (≈8 req/s)

export const MIN_PURCHASE_VALUE = 100_000  // $100 k

const SEC_HEADERS = {
  'User-Agent':       'TradingJournalPro/1.0 (contact: research@trading-journal.pro)',
  'Accept-Encoding':  'gzip, deflate',
  'Accept':           'application/json, text/html, application/xml',
}

// ─── public types ────────────────────────────────────────────────────────────

export interface InsiderPurchase {
  issuerName:      string
  issuerTicker:    string
  reporterName:    string
  reporterTitle:   string
  isDirector:      boolean
  isOfficer:       boolean
  transactionDate: string
  shares:          number
  pricePerShare:   number
  totalValue:      number
  filingUrl:       string
}

// ─── internal types ──────────────────────────────────────────────────────────

interface EftsFiling {
  entity_name:      string
  file_date:        string
  accession_no:     string
  entity_id:        string
  period_of_report: string
}

// ─── XML helpers (no external parser — Form 4 XML is simple & consistent) ────

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([^<]*)<\\/${name}>`))
  return m?.[1]?.trim() ?? ''
}

/** Extracts <name><value>…</value></name> patterns */
function nestedVal(xml: string, name: string): string {
  const outer = xml.match(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`))
  if (!outer) return ''
  return tag(outer[0], 'value')
}

function blocks(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`, 'g')) ?? []
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

async function efetch(url: string): Promise<Response | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: SEC_HEADERS })
      if (res.status === 429) { await sleep(2_000 * (i + 1)); continue }
      return res
    } catch {
      if (i === 2) return null
      await sleep(1_000 * (i + 1))
    }
  }
  return null
}

// ─── EDGAR EFTS filing list ───────────────────────────────────────────────────

async function listFilings(startDate: string, endDate: string): Promise<EftsFiling[]> {
  const out: EftsFiling[] = []
  let from = 0

  while (out.length < MAX_FILINGS) {
    const url = `${EFTS_SEARCH}?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&from=${from}`
    const res = await efetch(url)
    if (!res?.ok) break

    const data = await res.json()
    const hits: { _source: EftsFiling }[] = data.hits?.hits ?? []
    if (!hits.length) break

    out.push(...hits.map(h => h._source))

    const total: number = data.hits?.total?.value ?? 0
    if (out.length >= total) break

    from += EFTS_PAGE
    await sleep(120)  // keep under 10 req/s
  }

  return out.slice(0, MAX_FILINGS)
}

// ─── Fetch Form 4 XML from EDGAR archive ─────────────────────────────────────

async function fetchForm4Xml(cik: string, accessionNo: string): Promise<string | null> {
  const acc  = accessionNo.replace(/-/g, '')
  const base = `${EDGAR_ARCHIVE}/${cik}/${acc}`

  // Attempt 1: parse the filing index HTML to find the primary XML document
  const indexRes = await efetch(`${base}/${acc}-index.htm`)
  if (indexRes?.ok) {
    const html = await indexRes.text()
    // The index table has href="/Archives/…/<doc>.xml" for the primary doc
    const m = html.match(/href="([^"]+\.xml)"/)
    if (m) {
      const xmlUrl = m[1].startsWith('http')
        ? m[1]
        : `https://www.sec.gov${m[1]}`
      const r = await efetch(xmlUrl)
      if (r?.ok) {
        const t = await r.text()
        if (t.includes('<ownershipDocument>')) return t
      }
    }
  }

  // Attempt 2: common Form 4 XML filename patterns (no index needed)
  for (const name of [`${acc}.xml`, 'form4.xml', 'primary_doc.xml']) {
    const r = await efetch(`${base}/${name}`)
    if (r?.ok) {
      const t = await r.text()
      if (t.includes('<ownershipDocument>')) return t
    }
  }

  return null
}

// ─── Form 4 XML → InsiderPurchase[] ──────────────────────────────────────────

function parseForm4(xml: string, cik: string, accessionNo: string): InsiderPurchase[] {
  const issuerName   = tag(xml, 'issuerName')
  const issuerTicker = tag(xml, 'issuerTradingSymbol')
  const reporterName = tag(xml, 'rptOwnerName')
  const isDirector   = tag(xml, 'isDirector') === '1'
  const isOfficer    = tag(xml, 'isOfficer')  === '1'
  const rawTitle     = tag(xml, 'officerTitle')
  const reporterTitle = rawTitle
    || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  const acc       = accessionNo.replace(/-/g, '')
  const issuerCik = tag(xml, 'issuerCik').replace(/^0+/, '') || cik
  const filingUrl = `https://www.sec.gov/Archives/edgar/data/${issuerCik}/${acc}/${acc}-index.htm`

  return blocks(xml, 'nonDerivativeTransaction').flatMap(block => {
    // Only open-market purchases: code "P" + acquired "A"
    if (tag(block, 'transactionCode') !== 'P') return []
    if (nestedVal(block, 'transactionAcquiredDisposedCode') !== 'A') return []

    const shares = parseFloat(nestedVal(block, 'transactionShares')       || '0')
    const price  = parseFloat(nestedVal(block, 'transactionPricePerShare') || '0')
    const totalValue = shares * price

    if (totalValue < MIN_PURCHASE_VALUE || shares <= 0 || price <= 0) return []

    const transactionDate =
      nestedVal(block, 'transactionDate') || tag(xml, 'periodOfReport')

    return [{
      issuerName,
      issuerTicker,
      reporterName,
      reporterTitle,
      isDirector,
      isOfficer,
      transactionDate,
      shares,
      pricePerShare: price,
      totalValue,
      filingUrl,
    }]
  })
}

// ─── Batch processor ─────────────────────────────────────────────────────────

async function processBatch(filings: EftsFiling[]): Promise<InsiderPurchase[]> {
  const settled = await Promise.allSettled(
    filings.map(async f => {
      const xml = await fetchForm4Xml(f.entity_id, f.accession_no)
      return xml ? parseForm4(xml, f.entity_id, f.accession_no) : []
    })
  )
  return settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
}

// ─── Main public export ───────────────────────────────────────────────────────

export async function scanInsiderPurchases(): Promise<InsiderPurchase[]> {
  const now       = new Date()
  const startDate = format(subDays(now, 1), 'yyyy-MM-dd')
  const endDate   = format(now,             'yyyy-MM-dd')

  console.log(`[EDGAR] Fetching Form 4 filings ${startDate} → ${endDate}`)
  const filings = await listFilings(startDate, endDate)
  console.log(`[EDGAR] Processing ${filings.length} filings...`)

  const all: InsiderPurchase[] = []
  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    all.push(...await processBatch(filings.slice(i, i + BATCH_SIZE)))
    if (i + BATCH_SIZE < filings.length) await sleep(TICK_MS)
  }

  console.log(`[EDGAR] Found ${all.length} purchase(s) ≥ $${MIN_PURCHASE_VALUE.toLocaleString()}`)
  return all.sort((a, b) => b.totalValue - a.totalValue)
}

// ─── Slack message builder ────────────────────────────────────────────────────

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

export function buildSlackMessage(purchases: InsiderPurchase[]): string {
  const threshold = usd(MIN_PURCHASE_VALUE)
  const ts        = new Date().toUTCString()

  if (!purchases.length) {
    return [
      `*📊 SEC Insider Purchases — Last 24h*`,
      `_No open-market buys ≥ ${threshold} found. Source: SEC EDGAR Form 4 • ${ts}_`,
    ].join('\n')
  }

  const MEDALS = ['🥇', '🥈', '🥉']
  const lines: string[] = [
    `*📊 SEC EDGAR — Insider Purchases (Last 24h)*`,
    `_Open-market buys ≥ ${threshold}  •  ${purchases.length} transaction(s) found_`,
    '',
  ]

  purchases.forEach((p, i) => {
    const rank   = MEDALS[i] ?? `#${i + 1}`
    const ticker = p.issuerTicker ? ` (${p.issuerTicker})` : ''
    lines.push(`${rank}  *${p.issuerName}${ticker}*  —  ${p.reporterName}`)
    lines.push(`   _${p.reporterTitle}_  |  ${p.shares.toLocaleString()} shares @ ${usd(p.pricePerShare)}/sh`)
    lines.push(`   *Total: ${usd(p.totalValue)}*  |  ${p.transactionDate}`)
    lines.push(`   <${p.filingUrl}|View SEC Filing>`)
    lines.push('')
  })

  lines.push(`_Source: SEC EDGAR Form 4  •  ${ts}_`)
  return lines.join('\n')
}

// ─── Slack webhook sender ─────────────────────────────────────────────────────

export async function postToSlack(message: string, webhookUrl: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text: message, mrkdwn: true }),
  })
  if (!res.ok) {
    throw new Error(`Slack webhook error: ${res.status} ${res.statusText}`)
  }
}
