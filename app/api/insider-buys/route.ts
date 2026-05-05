import { NextResponse } from 'next/server'

// ─── Constants ───────────────────────────────────────────────────────────────
const EDGAR_EFTS = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'
// SEC requires a descriptive User-Agent with contact info
const SEC_USER_AGENT = 'TradingJournalPro contact@tradingjournalpro.com'
const MIN_PURCHASE_VALUE = 100_000 // $100 000 minimum to qualify
const MAX_FILINGS = 100 // cap per run to stay within rate limits
const BATCH_SIZE = 10 // concurrent XML fetches per batch
const SLACK_DEFAULT_CHANNEL = 'C0ATEAY4P6H' // #all-claude-trading

// ─── Types ───────────────────────────────────────────────────────────────────
interface InsiderBuy {
  insiderName: string
  role: string
  companyName: string
  ticker: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingDate: string
}

// ─── Utilities ───────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  return `$${(n / 1_000).toFixed(0)}K`
}

// Wraps fetch with the User-Agent header required by SEC EDGAR
async function secFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: '*/*' },
  })
}

// ─── XML helpers (Form 4 follows a predictable schema — no lib needed) ────────
/** Content between <tag>…</tag> (first match, non-greedy) */
function xmlBlock(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

/** Inline text between <tag>text</tag> (no child elements) */
function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

/** Value from the <tag><value>…</value></tag> pattern common in Form 4 */
function xmlVal(xml: string, tag: string): string {
  const block = xmlBlock(xml, tag)
  if (!block) return ''
  return xmlText(block, 'value') || block.replace(/<[^>]+>/g, '').trim()
}

// ─── Form 4 XML Parser ───────────────────────────────────────────────────────
function parseForm4(xml: string, filingDate: string): InsiderBuy[] {
  const results: InsiderBuy[] = []

  // Issuer (the company whose stock was bought)
  const issuerBlock = xmlBlock(xml, 'issuer')
  const companyName = xmlText(issuerBlock, 'issuerName') || xmlText(xml, 'issuerName')
  const ticker =
    xmlText(issuerBlock, 'issuerTradingSymbol') || xmlText(xml, 'issuerTradingSymbol')

  // Reporting owner (the insider)
  const ownerBlock = xmlBlock(xml, 'reportingOwner')
  const insiderName =
    xmlText(xmlBlock(ownerBlock, 'reportingOwnerId'), 'rptOwnerName') ||
    xmlText(xml, 'rptOwnerName')

  const relBlock =
    xmlBlock(ownerBlock, 'reportingOwnerRelationship') ||
    xmlBlock(xml, 'reportingOwnerRelationship')

  const isDirector = xmlText(relBlock, 'isDirector') === '1'
  const isOfficer = xmlText(relBlock, 'isOfficer') === '1'

  // Skip filings not from executives or board directors
  if (!isDirector && !isOfficer) return results

  const officerTitle = xmlText(relBlock, 'officerTitle').trim()
  const role = officerTitle || (isDirector ? 'Director' : 'Officer')

  // Scan all non-derivative transactions in this filing
  const nonDerivTable = xmlBlock(xml, 'nonDerivativeTable')
  if (!nonDerivTable) return results

  const txRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  let m: RegExpExecArray | null
  while ((m = txRe.exec(nonDerivTable)) !== null) {
    const tx = m[1]

    // Transaction code P = open-market purchase (the only type we want)
    const txCode = xmlText(xmlBlock(tx, 'transactionCoding'), 'transactionCode')
    if (txCode !== 'P') continue

    // Must be an acquisition (A), not a disposal (D)
    if (xmlVal(tx, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(xmlVal(tx, 'transactionShares')) || 0
    const price = parseFloat(xmlVal(tx, 'transactionPricePerShare')) || 0
    const total = shares * price

    if (!shares || !price || total < MIN_PURCHASE_VALUE) continue

    results.push({
      insiderName: insiderName || 'Unknown',
      role,
      companyName: companyName || 'Unknown',
      ticker: ticker || '—',
      shares,
      pricePerShare: price,
      totalValue: total,
      transactionDate: xmlVal(tx, 'transactionDate') || filingDate,
      filingDate,
    })
  }

  return results
}

// ─── EDGAR API ───────────────────────────────────────────────────────────────
/** Search EDGAR EFTS for recent Form 4 filings */
async function fetchRecentForm4Filings(
  startDate: string,
  endDate: string,
): Promise<any[]> {
  const params = new URLSearchParams({
    forms: '4',
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: '0',
    size: String(MAX_FILINGS),
  })
  const res = await secFetch(`${EDGAR_EFTS}?${params}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.hits?.hits ?? []
}

/**
 * Try to retrieve the Form 4 XML for a given accession number.
 * The filer's CIK is encoded in the first segment of the accession number.
 * We try common filename patterns before giving up.
 */
async function fetchForm4XML(accNo: string): Promise<string | null> {
  const cik = String(parseInt(accNo.split('-')[0], 10)) // strip leading zeros
  const nodash = accNo.replace(/-/g, '')

  for (const filename of [`${nodash}.xml`, 'form4.xml', 'doc4.xml']) {
    try {
      const res = await secFetch(`${EDGAR_ARCHIVES}/${cik}/${nodash}/${filename}`)
      if (res.ok) {
        const text = await res.text()
        if (text.includes('<ownershipDocument')) return text
      }
    } catch {
      // try next filename pattern
    }
    await sleep(50) // brief pause between candidates
  }
  return null
}

/** Process all filing hits in rate-limited batches */
async function processFilings(hits: any[]): Promise<InsiderBuy[]> {
  const allBuys: InsiderBuy[] = []

  for (let i = 0; i < hits.length; i += BATCH_SIZE) {
    const batch = hits.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (hit) => {
        const accNo: string = hit._source?.accession_no || hit._id
        const filingDate: string = hit._source?.file_date || ''
        if (!accNo) return []
        const xml = await fetchForm4XML(accNo)
        if (!xml) return []
        return parseForm4(xml, filingDate)
      }),
    )
    batchResults.forEach((r) => allBuys.push(...r))
    if (i + BATCH_SIZE < hits.length) await sleep(200) // SEC rate-limit buffer
  }

  return allBuys
}

// ─── Slack ───────────────────────────────────────────────────────────────────
function buildSlackMessage(
  buys: InsiderBuy[],
  startDate: string,
  endDate: string,
): string {
  const sorted = [...buys].sort((a, b) => b.totalValue - a.totalValue)
  const dateLabel =
    startDate === endDate ? startDate : `${startDate} → ${endDate}`

  if (sorted.length === 0) {
    return (
      `*📊 SEC Insider Purchases — ${dateLabel}*\n\n` +
      `No qualifying open-market purchases (>$100K) found in this period.`
    )
  }

  const medals = ['🥇', '🥈', '🥉']
  const rows = sorted.slice(0, 20).map((b, i) => {
    const rank = medals[i] ?? `${i + 1}.`
    return [
      `${rank} *${b.ticker}* — ${b.companyName}`,
      `   👤 ${b.insiderName} *(${b.role})*`,
      `   💰 *${fmtUSD(b.totalValue)}* @ $${b.pricePerShare.toFixed(2)}/share · ${b.shares.toLocaleString()} shares`,
      `   📅 Transacted: ${b.transactionDate} | Filed: ${b.filingDate}`,
    ].join('\n')
  })

  const tail =
    sorted.length > 20
      ? `\n_...and ${sorted.length - 20} more. Showing top 20 by value._`
      : ''

  return [
    `*📊 SEC Insider Purchases — ${dateLabel}*`,
    `_Executives & Directors · open-market buys only · min $100K · ranked by value_`,
    `_${sorted.length} qualifying purchase${sorted.length !== 1 ? 's' : ''} found_`,
    '',
    ...rows,
    tail,
  ].join('\n')
}

/** Send via Incoming Webhook (SLACK_WEBHOOK_URL) or Bot Token (SLACK_BOT_TOKEN) */
async function sendToSlack(message: string): Promise<boolean> {
  const webhook = process.env.SLACK_WEBHOOK_URL
  if (webhook) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    })
    return res.ok
  }

  const token = process.env.SLACK_BOT_TOKEN
  if (token) {
    const channelId = process.env.SLACK_CHANNEL_ID || SLACK_DEFAULT_CHANNEL
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: channelId, text: message, mrkdwn: true }),
    })
    return res.ok
  }

  return false // no Slack credentials configured
}

// ─── Route Handler ───────────────────────────────────────────────────────────
export async function GET() {
  try {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().split('T')[0]
    const startDate = fmt(yesterday)
    const endDate = fmt(now)

    const hits = await fetchRecentForm4Filings(startDate, endDate)
    const buys = await processFilings(hits)
    const sorted = buys.sort((a, b) => b.totalValue - a.totalValue)

    const message = buildSlackMessage(sorted, startDate, endDate)
    const slackSent = await sendToSlack(message)

    return NextResponse.json({
      success: true,
      dateRange: { startDate, endDate },
      totalFilingsScanned: hits.length,
      qualifyingPurchases: sorted.length,
      slackSent,
      purchases: sorted,
    })
  } catch (err) {
    console.error('[insider-buys]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
