import { NextResponse } from 'next/server'

// ─── Constants ────────────────────────────────────────────────────────────────
const EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVE = 'https://www.sec.gov/Archives'
const SLACK_API = 'https://slack.com/api/chat.postMessage'
// SEC requires a User-Agent identifying the app and a contact email
const UA = 'TradingJournalPro/1.0 admin@tradingjournalpro.com'
const MIN_VALUE = 100_000

// ─── Types ────────────────────────────────────────────────────────────────────
interface InsiderBuy {
  companyName: string
  ticker: string
  insiderName: string
  insiderTitle: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
}

interface EdgarHit {
  _id?: string
  _source?: {
    accession_no?: string
    file_date?: string
    period_of_report?: string
    display_names?: string[]
    entity_name?: string
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

/**
 * Parse Form 4 XML for open-market purchases (transaction code P, acquired A)
 * above the minimum threshold. Merges multiple transactions by the same
 * insider/issuer pair.
 */
function parseForm4Buys(xml: string): InsiderBuy[] {
  const buys: InsiderBuy[] = []

  const company =
    xml.match(/<issuerName>([^<]+)<\/issuerName>/)?.[1]?.trim() ?? 'Unknown'
  const ticker =
    xml.match(/<issuerTradingSymbol>([^<]+)<\/issuerTradingSymbol>/)?.[1]
      ?.trim()
      .toUpperCase() ?? ''
  const insider =
    xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/)?.[1]?.trim() ?? 'Unknown'
  const officerTitle =
    xml.match(/<officerTitle>([^<]+)<\/officerTitle>/)?.[1]?.trim()
  const isDirector = /<isDirector>1<\/isDirector>/.test(xml)
  const isOfficer = /<isOfficer>1<\/isOfficer>/.test(xml)
  const insiderTitle =
    officerTitle ||
    (isDirector && isOfficer
      ? 'Director & Officer'
      : isDirector
      ? 'Director'
      : isOfficer
      ? 'Officer'
      : 'Insider')

  const txRe =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g
  let m: RegExpExecArray | null
  while ((m = txRe.exec(xml)) !== null) {
    const tx = m[1]

    // Only open-market purchases
    const code = tx.match(/<transactionCode>([^<]+)<\/transactionCode>/)?.[1]?.trim()
    if (code !== 'P') continue
    const ad = tx
      .match(/<transactionAcquiredDisposedCode>\s*<value>([^<]+)<\/value>/)?.[1]
      ?.trim()
    if (ad !== 'A') continue

    const shares = parseFloat(
      tx
        .match(/<transactionShares>\s*<value>([\d.,]+)<\/value>/)?.[1]
        ?.replace(/,/g, '') ?? '0',
    )
    const price = parseFloat(
      tx
        .match(/<transactionPricePerShare>\s*<value>([\d.,]+)<\/value>/)?.[1]
        ?.replace(/,/g, '') ?? '0',
    )
    const txDate =
      tx.match(/<transactionDate>\s*<value>([^<]+)<\/value>/)?.[1]?.trim() ?? ''

    if (shares <= 0 || price <= 0) continue
    const total = shares * price
    if (total < MIN_VALUE) continue

    const existing = buys.find(
      b => b.companyName === company && b.insiderName === insider,
    )
    if (existing) {
      existing.shares += shares
      existing.totalValue += total
      existing.pricePerShare = existing.totalValue / existing.shares
    } else {
      buys.push({
        companyName: company,
        ticker,
        insiderName: insider,
        insiderTitle,
        shares,
        pricePerShare: price,
        totalValue: total,
        transactionDate: txDate,
      })
    }
  }

  return buys
}

/**
 * Fetch the Form 4 XML document for a given EDGAR search hit.
 * First tries the direct document URL embedded in _id; falls back to
 * fetching the filing index JSON and locating the primary XML file.
 */
async function fetchFilingXML(hit: EdgarHit): Promise<string | null> {
  const headers = { 'User-Agent': UA }

  // Direct attempt via the _id path (EFTS indexes primary documents directly)
  const id = hit._id ?? ''
  if (id && !id.endsWith('-index.htm')) {
    try {
      const r = await fetch(`${EDGAR_ARCHIVE}/${id}`, { headers })
      if (r.ok) {
        const t = await r.text()
        if (t.includes('<ownershipDocument>')) return t
      }
    } catch {
      // fall through to index-based lookup
    }
  }

  // Fallback: use the accession number → filing index JSON → XML filename
  const accNo = hit._source?.accession_no ?? ''
  if (!accNo) return null

  const rawCik =
    (hit._source?.display_names?.[0] ?? '').match(/CIK (\d+)/i)?.[1] ??
    accNo.split('-')[0]
  const cik = parseInt(rawCik, 10)
  if (!cik) return null

  const accNoDash = accNo.replace(/-/g, '')
  try {
    const idxRes = await fetch(
      `${EDGAR_ARCHIVE}/edgar/data/${cik}/${accNoDash}/${accNo}-index.json`,
      { headers },
    )
    if (!idxRes.ok) return null
    const idx = await idxRes.json()

    const xmlName: string | undefined = (
      idx.directory?.item as Array<{ type: string; name: string }> | undefined
    )?.find(f => f.type === '4' && f.name.endsWith('.xml'))?.name
    if (!xmlName) return null

    const xmlRes = await fetch(
      `${EDGAR_ARCHIVE}/edgar/data/${cik}/${accNoDash}/${xmlName}`,
      { headers },
    )
    if (!xmlRes.ok) return null
    const t = await xmlRes.text()
    return t.includes('<ownershipDocument>') ? t : null
  } catch {
    return null
  }
}

/**
 * Process items in batches with a 1.1 s pause between batches to stay
 * under the SEC EDGAR fair-access guideline of 10 requests/second.
 */
async function batchProcess<T, R>(
  items: T[],
  fn: (x: T) => Promise<R>,
  batchSize = 8,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    out.push(...(await Promise.all(batch.map(fn))))
    if (i + batchSize < items.length) {
      await new Promise<void>(resolve => setTimeout(resolve, 1100))
    }
  }
  return out
}

async function postToSlack(text: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND' // #sec-form4-insider-scanner
  if (!token) {
    console.warn('[insider-buys] SLACK_BOT_TOKEN not set — skipping Slack post')
    return { ok: false, error: 'missing_token' }
  }
  const res = await fetch(SLACK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  })
  return res.json()
}

function buildSlackMessage(
  buys: InsiderBuy[],
  startDate: string,
  endDate: string,
): string {
  const top = buys.slice(0, 20)
  const rows = top
    .map((b, i) => {
      const tick = b.ticker ? ` (${b.ticker})` : ''
      return [
        `*${i + 1}. ${b.companyName}${tick}*`,
        `   ${b.insiderName} — ${b.insiderTitle}`,
        `   ${fmtCurrency(b.totalValue)} · ${b.shares.toLocaleString()} shares @ $${b.pricePerShare.toFixed(2)}`,
        `   Date: ${b.transactionDate}`,
      ].join('\n')
    })
    .join('\n\n')

  return [
    `:chart_with_upwards_trend: *SEC EDGAR Insider Buys — Last 24 Hours* (>${fmtCurrency(MIN_VALUE)} threshold)`,
    `_${startDate} → ${endDate}  ·  ${buys.length} qualifying purchase${buys.length !== 1 ? 's' : ''} found_`,
    '',
    rows,
    '',
    `_Source: SEC EDGAR Form 4 filings_`,
  ].join('\n')
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const startDate = yesterday.toISOString().slice(0, 10)
    const endDate = now.toISOString().slice(0, 10)

    // 1. Query EDGAR EFTS for all Form 4 filings in the window (up to 200)
    const searchRes = await fetch(
      `${EFTS_BASE}?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&from=0&size=200`,
      { headers: { 'User-Agent': UA } },
    )
    if (!searchRes.ok) {
      throw new Error(`EDGAR EFTS responded with ${searchRes.status}`)
    }
    const searchData = await searchRes.json()
    const hits: EdgarHit[] = searchData.hits?.hits ?? []

    if (hits.length === 0) {
      const msg = `No Form 4 filings found between ${startDate} and ${endDate}.`
      await postToSlack(msg)
      return NextResponse.json({ message: msg, buys: [] })
    }

    // 2. Fetch and parse each XML filing in rate-limited batches
    const xmlDocs = await batchProcess(hits, fetchFilingXML, 8)

    const allBuys: InsiderBuy[] = []
    hits.forEach((hit, i) => {
      const xml = xmlDocs[i]
      if (!xml) return
      const filingDate = hit._source?.file_date ?? endDate
      const parsed = parseForm4Buys(xml)
      // Back-fill filing date for transactions without an explicit date
      parsed.forEach(b => {
        if (!b.transactionDate) b.transactionDate = filingDate
      })
      allBuys.push(...parsed)
    })

    // 3. Rank by total purchase value, largest first
    allBuys.sort((a, b) => b.totalValue - a.totalValue)

    if (allBuys.length === 0) {
      const msg = `:mag: No insider purchases over ${fmtCurrency(MIN_VALUE)} found in the last 24 hours.`
      await postToSlack(msg)
      return NextResponse.json({ message: msg, buys: [] })
    }

    // 4. Build and post the Slack summary
    const message = buildSlackMessage(allBuys, startDate, endDate)
    const slackResult = await postToSlack(message)

    return NextResponse.json({
      success: true,
      dateRange: { startDate, endDate },
      total: allBuys.length,
      slackOk: slackResult.ok,
      buys: allBuys,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[insider-buys]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
