import { NextResponse } from 'next/server'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MIN_VALUE = 100_000          // $100 K minimum purchase to include
const MAX_FILINGS = 100            // cap at 100 Form 4 filings per run
const BATCH_SIZE = 5               // concurrent SEC EDGAR requests
const EDGAR = 'https://www.sec.gov'
const EFTS = 'https://efts.sec.gov'
const DEFAULT_CHANNEL = 'C0ATEAY4P6H'   // #all-claude-trading
// SEC requires a descriptive User-Agent with contact info
const SEC_UA = 'TradingJournalPro insider-monitor@trading-journal-pro.com'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface InsiderBuy {
  issuerName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  transactionDate: string
  shares: number
  pricePerShare: number
  totalValue: number
  filingUrl: string
}

// ---------------------------------------------------------------------------
// XML helpers (Form 4 uses a predictable schema — no parser needed)
// ---------------------------------------------------------------------------

/**
 * Extracts the inner value from Form 4's pattern: <tag><value>X</value></tag>
 * Falls back to plain <tag>X</tag> for simple string fields.
 */
function xmlGet(xml: string, tag: string): string {
  const withValue = new RegExp(
    `<${tag}[^>]*>\\s*<value>\\s*([^<]*?)\\s*<\\/value>`, 'is',
  )
  const plain = new RegExp(`<${tag}[^>]*>\\s*([^<]+?)\\s*<\\/${tag}>`, 'is')
  return (xml.match(withValue) ?? xml.match(plain))?.[1]?.trim() ?? ''
}

/**
 * Parses a Form 4 XML document and returns all open-market purchase entries.
 * Only includes transactions with transactionCode=P and acquired/disposed=A.
 */
function parseForm4(xml: string, filingUrl: string): InsiderBuy[] {
  const issuerName = xmlGet(xml, 'issuerName')
  const ticker     = xmlGet(xml, 'issuerTradingSymbol').toUpperCase()
  const ownerName  = xmlGet(xml, 'rptOwnerName')

  // Determine insider title from relationship flags
  const isDir = /<isDirector[^>]*>\s*<value>\s*1/.test(xml)
  const isOff = /<isOfficer[^>]*>\s*<value>\s*1/.test(xml)
  const officerTitle = xmlGet(xml, 'officerTitle')
  const title = officerTitle || (isDir ? 'Director' : isOff ? 'Officer' : 'Insider')

  // Walk every <nonDerivativeTransaction> block
  const txnRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi
  const buys: InsiderBuy[] = []
  let m: RegExpExecArray | null

  while ((m = txnRe.exec(xml)) !== null) {
    const blk = m[1]

    // Filter: open-market purchase (P) that was acquired (A)
    if (xmlGet(blk, 'transactionCode') !== 'P') continue
    if (xmlGet(blk, 'transactionAcquiredDisposedCode') !== 'A') continue

    const shares = parseFloat(xmlGet(blk, 'transactionShares'))
    const price  = parseFloat(xmlGet(blk, 'transactionPricePerShare'))
    if (!shares || !price || shares <= 0 || price <= 0) continue

    buys.push({
      issuerName,
      ticker,
      insiderName: ownerName,
      insiderTitle: title,
      transactionDate: xmlGet(blk, 'transactionDate'),
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      filingUrl,
    })
  }

  return buys
}

// ---------------------------------------------------------------------------
// SEC EDGAR fetch helpers
// ---------------------------------------------------------------------------

function secGet(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': SEC_UA },
    signal: AbortSignal.timeout(15_000),
  })
}

/**
 * Fetches the filing index HTML for an accession number and
 * returns the URL of the primary Form 4 XML document.
 */
async function getXmlUrl(accNo: string): Promise<string | null> {
  const cik    = String(parseInt(accNo.split('-')[0], 10))
  const noDash = accNo.replace(/-/g, '')
  const indexUrl = `${EDGAR}/Archives/edgar/data/${cik}/${noDash}/`

  try {
    const res = await secGet(indexUrl)
    if (!res.ok) return null

    const html = await res.text()
    // Find the href pointing to a .xml file in the documents table
    const href = html.match(/href="([^"]*\.xml)"/i)?.[1]
    if (!href) return null

    return href.startsWith('http') ? href : `${EDGAR}${href}`
  } catch {
    return null
  }
}

/**
 * Resolves and parses a single Form 4 filing.
 * Returns an empty array on any network or parse failure.
 */
async function processAccession(accNo: string): Promise<InsiderBuy[]> {
  const cik    = String(parseInt(accNo.split('-')[0], 10))
  const noDash = accNo.replace(/-/g, '')
  const filingUrl = `${EDGAR}/Archives/edgar/data/${cik}/${noDash}/`

  const xmlUrl = await getXmlUrl(accNo)
  if (!xmlUrl) return []

  try {
    const res = await secGet(xmlUrl)
    if (!res.ok) return []
    const xml = await res.text()
    return parseForm4(xml, filingUrl)
  } catch {
    return []
  }
}

/** Runs an async function over an array in fixed-size concurrent batches. */
async function runBatches<T, R>(
  items: T[],
  fn: (x: T) => Promise<R>,
  concurrency = BATCH_SIZE,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    out.push(...(await Promise.all(chunk.map(fn))))
  }
  return out
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${(n / 1e3).toFixed(0)}K`
}

function buildSlackMessage(buys: InsiderBuy[], window: string): string {
  const header =
    `*:chart_with_upwards_trend: SEC Insider Purchases — ${window}*\n` +
    `_Open-market buys >$100K in the last 24 hours — ranked by size_`

  if (!buys.length) {
    return `${header}\n\nNo significant insider purchases found in this period.`
  }

  const rows = buys.slice(0, 20).map((b, i) => {
    const shares = b.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })
    const label  = b.ticker ? `${b.ticker} (${b.issuerName})` : b.issuerName
    return [
      `*${i + 1}. ${label}* — *${fmtMoney(b.totalValue)}*`,
      `   ${b.insiderName} | ${b.insiderTitle}`,
      `   ${shares} shares @ $${b.pricePerShare.toFixed(2)} | ${b.transactionDate}`,
      `   <${b.filingUrl}|View SEC filing>`,
    ].join('\n')
  })

  return `${header}\n\n${rows.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Slack posting
// ---------------------------------------------------------------------------

async function postToSlack(text: string, channel: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN env var is not set')

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, mrkdwn: true, unfurl_links: false }),
  })

  const data = (await res.json()) as { ok: boolean; error?: string }
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`)
}

// ---------------------------------------------------------------------------
// Route handler — GET /api/insider-buys
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const channel = searchParams.get('channel') ?? process.env.SLACK_INSIDER_CHANNEL ?? DEFAULT_CHANNEL

  // Build the 24-hour window
  const now       = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const toIso     = (d: Date) => d.toISOString().slice(0, 10)
  const startDate = toIso(yesterday)
  const endDate   = toIso(now)
  const windowLabel = `${startDate} → ${endDate}`

  // -------------------------------------------------------------------------
  // Step 1 — fetch Form 4 accession numbers from EDGAR EFTS
  // -------------------------------------------------------------------------
  const accessionNums: string[] = []
  const pagesNeeded = Math.ceil(MAX_FILINGS / 10)

  for (let page = 0; page < pagesNeeded && accessionNums.length < MAX_FILINGS; page++) {
    const url =
      `${EFTS}/LATEST/search-index?forms=4&dateRange=custom` +
      `&startdt=${startDate}&enddt=${endDate}&from=${page * 10}`

    try {
      const r = await secGet(url)
      if (!r.ok) break

      const data = await r.json() as {
        hits?: { hits?: Array<{ _id?: string; _source?: { accession_no?: string } }> }
      }

      const hits = data.hits?.hits ?? []
      if (!hits.length) break

      for (const h of hits) {
        const acc = h._source?.accession_no ?? h._id
        if (acc && !accessionNums.includes(acc)) accessionNums.push(acc)
      }
    } catch {
      break   // network failure — work with what we have
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — fetch + parse each filing (batched concurrently)
  // -------------------------------------------------------------------------
  const nested = await runBatches(accessionNums, processAccession)
  const allBuys = nested.flat()

  // -------------------------------------------------------------------------
  // Step 3 — filter >$100K, require a ticker, rank by value descending
  // -------------------------------------------------------------------------
  const significant = allBuys
    .filter(b => b.totalValue >= MIN_VALUE && b.ticker)
    .sort((a, b) => b.totalValue - a.totalValue)

  // -------------------------------------------------------------------------
  // Step 4 — post ranked summary to Slack
  // -------------------------------------------------------------------------
  const message = buildSlackMessage(significant, windowLabel)

  try {
    await postToSlack(message, channel)
  } catch (err) {
    return NextResponse.json(
      { error: String(err), window: windowLabel, filingsFetched: accessionNums.length },
      { status: 502 },
    )
  }

  return NextResponse.json({
    ok: true,
    window: windowLabel,
    filingsFetched: accessionNums.length,
    significantBuys: significant.length,
    topBuys: significant.slice(0, 10).map(b => ({
      ticker:  b.ticker,
      company: b.issuerName,
      insider: b.insiderName,
      title:   b.insiderTitle,
      value:   fmtMoney(b.totalValue),
      date:    b.transactionDate,
    })),
  })
}
