import { NextResponse } from 'next/server'

const SEC_UA = `TradingJournalPro ${process.env.SEC_CONTACT_EMAIL ?? 'support@tradingjournalpro.com'}`
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND' // #sec-form4-insider-scanner
const MIN_BUY_VALUE = 100_000

// ─── Types ───────────────────────────────────────────────────────────────────

interface EdgarHit {
  _source: {
    entity_name: string
    file_date: string
    period_of_report: string
    accession_no: string
    display_names?: string[]
  }
}

interface InsiderBuy {
  rank: number
  company: string
  ticker: string
  insiderName: string
  title: string
  shares: number
  pricePerShare: number
  totalValue: number
  transactionDate: string
  filingUrl: string
}

// ─── SEC EDGAR helpers ────────────────────────────────────────────────────────

async function edgarFetch(url: string, accept = '*/*') {
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_UA, Accept: accept },
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`EDGAR ${res.status}: ${url}`)
  return res
}

async function getRecentForm4Filings(startDate: string, endDate: string): Promise<EdgarHit[]> {
  const url =
    `https://efts.sec.gov/LATEST/search-index?forms=4` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
    `&hits.hits._source=entity_name,file_date,period_of_report,accession_no,display_names` +
    `&hits.hits.total.value=true`

  const res = await edgarFetch(url, 'application/json')
  const data = await res.json()
  return (data.hits?.hits ?? []) as EdgarHit[]
}

// Extract CIK from accession number (first segment, zero-padded to 10 digits)
function cikFromAccession(accNo: string): string {
  return accNo.split('-')[0].replace(/^0+/, '')
}

async function findXmlFilename(cik: string, accNoClean: string, accNo: string): Promise<string> {
  try {
    const indexRes = await edgarFetch(
      `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoClean}/${accNo}-index.htm`,
      'text/html',
    )
    const html = await indexRes.text()
    const match = html.match(/href="([^"]*\.xml)"/i)
    if (match) return match[1].split('/').pop()!
  } catch {
    // fall through to default
  }
  return `${accNo}.xml`
}

async function parseForm4(accNo: string): Promise<InsiderBuy[]> {
  const cik = cikFromAccession(accNo)
  const accNoClean = accNo.replace(/-/g, '')

  const xmlFilename = await findXmlFilename(cik, accNoClean, accNo)
  const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoClean}/${xmlFilename}`
  const xml = await (await edgarFetch(xmlUrl, 'text/xml')).text()

  // Parse issuer / reporting owner
  const company = extractXml(xml, 'issuerName') ?? ''
  const ticker = extractXml(xml, 'issuerTradingSymbol') ?? ''
  const insiderName = extractXml(xml, 'rptOwnerName') ?? ''
  const officerTitle = extractXml(xml, 'officerTitle')
  const isDirector = xml.includes('<isDirector>1</isDirector>')
  const isOfficer = xml.includes('<isOfficer>1</isOfficer>')
  const title = officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')
  const filingBase = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoClean}/`

  // Parse non-derivative transaction blocks
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? []
  const results: InsiderBuy[] = []

  for (const block of blocks) {
    const code = extractXml(block, 'transactionCode')
    const acqDisp = block.match(/<transactionAcquiredDisposedCode>\s*<value>([^<]+)<\/value>/)?.[1]?.trim()

    // P = open-market purchase, A = acquired — either condition qualifies as a buy
    if (code !== 'P' && acqDisp !== 'A') continue

    const sharesVal = block.match(/<transactionShares>\s*<value>([^<]+)<\/value>/)?.[1]
    const priceVal = block.match(/<transactionPricePerShare>\s*<value>([^<]+)<\/value>/)?.[1]
    const dateVal = block.match(/<transactionDate>\s*<value>([^<]+)<\/value>/)?.[1]?.trim() ?? ''

    const shares = parseFloat(sharesVal ?? '0')
    const price = parseFloat(priceVal ?? '0')
    const totalValue = shares * price

    if (totalValue < MIN_BUY_VALUE || shares <= 0 || price <= 0) continue

    results.push({
      rank: 0,
      company,
      ticker,
      insiderName,
      title,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate: dateVal,
      filingUrl: filingBase,
    })
  }

  return results
}

function extractXml(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>(?:<value>)?([^<]+)(?:<\\/value>)?<\\/${tag}>`))?.[1]?.trim()
}

// ─── Concurrency-limited batch runner ────────────────────────────────────────

async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  delayMs = 125, // ~8 req/s — well under SEC's 10/s cap
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = []
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = tasks.slice(i, i + limit).map(t => t())
    const settled = await Promise.allSettled(batch)
    results.push(...settled)
    if (i + limit < tasks.length) await new Promise(r => setTimeout(r, delayMs))
  }
  return results
}

// ─── Slack formatter ──────────────────────────────────────────────────────────

function fmt$(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  return `$${Math.round(v / 1_000)}K`
}

function buildSlackPayload(buys: InsiderBuy[], generatedAt: string) {
  const total = buys.reduce((s, b) => s + b.totalValue, 0)
  const top = buys.slice(0, 15)

  const rows = top.map((b, i) => {
    const label = b.ticker ? `*${b.ticker}*  _${b.company}_` : `*${b.company}*`
    return (
      `*${i + 1}.* ${label}\n` +
      `   ${b.insiderName}  ·  ${b.title}\n` +
      `   ${fmt$(b.totalValue)}  ·  ${b.shares.toLocaleString()} sh @ $${b.pricePerShare.toFixed(2)}  ·  ${b.transactionDate}\n` +
      `   <${b.filingUrl}|View SEC Filing>`
    )
  })

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📈 SEC Form 4 — Insider Purchases  |  Last 24 Hours', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*${buys.length} purchase${buys.length !== 1 ? 's' : ''}* above $100K  ·  Combined value: *${fmt$(total)}*\n` +
            `_${generatedAt}_`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: rows.length ? rows.join('\n\n') : '_No qualifying purchases found._' },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Source: SEC EDGAR Form 4  ·  Ranked by total purchase value  ·  Directors & Officers only',
          },
        ],
      },
    ],
  }
}

async function postToSlack(payload: object): Promise<void> {
  if (SLACK_WEBHOOK_URL) {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`Slack webhook error: ${res.status}`)
    return
  }

  if (SLACK_BOT_TOKEN) {
    const body = { channel: SLACK_CHANNEL_ID, ...payload }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!json.ok) throw new Error(`Slack API error: ${json.error}`)
    return
  }

  throw new Error('No SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN configured')
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const notify = searchParams.get('notify') === 'slack'

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  try {
    const filings = await getRecentForm4Filings(fmt(yesterday), fmt(now))

    const tasks = filings.map(hit => () => parseForm4(hit._source.accession_no))
    const settled = await withConcurrencyLimit(tasks, 8)

    const allBuys: InsiderBuy[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') allBuys.push(...r.value)
    }

    allBuys.sort((a, b) => b.totalValue - a.totalValue)
    allBuys.forEach((b, i) => (b.rank = i + 1))

    const generatedAt = now.toUTCString()

    if (notify) {
      const payload = buildSlackPayload(allBuys, generatedAt)
      await postToSlack(payload)
    }

    return NextResponse.json({
      generatedAt,
      totalFilingsParsed: filings.length,
      purchasesAbove100k: allBuys.length,
      purchases: allBuys,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
