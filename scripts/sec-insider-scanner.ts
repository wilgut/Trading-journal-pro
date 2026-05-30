#!/usr/bin/env npx ts-node
/**
 * SEC Form 4 Insider Buy Scanner
 *
 * Fetches Form 4 filings from SEC EDGAR for the last 24 hours,
 * filters for open-market purchases > $100K, and posts a ranked
 * summary to Slack.
 *
 * Usage:
 *   npx ts-node scripts/sec-insider-scanner.ts
 *   npx ts-node scripts/sec-insider-scanner.ts --dry-run   # print only, no Slack post
 *   npx ts-node scripts/sec-insider-scanner.ts --hours 48  # look back further
 *
 * Environment variables:
 *   SEC_CONTACT_EMAIL   – required by SEC fair-use policy (your email)
 *   SLACK_WEBHOOK_URL   – Slack Incoming Webhook URL  OR
 *   SLACK_BOT_TOKEN     – Slack Bot token (needs chat:write scope)
 *   SLACK_CHANNEL_ID    – channel to post to (default: #sec-form4-insider-scanner)
 *   MIN_PURCHASE_VALUE  – minimum USD value to include (default: 100000)
 *
 * Cron example (run every weekday at 6 AM EST):
 *   0 11 * * 1-5 cd /path/to/project && npx ts-node scripts/sec-insider-scanner.ts >> /var/log/insider-scanner.log 2>&1
 */

import * as https from 'https'
import * as http from 'http'

// ─── Config ───────────────────────────────────────────────────────────────────

const SEC_UA = `TradingJournalPro ${process.env.SEC_CONTACT_EMAIL ?? 'support@tradingjournalpro.com'}`
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND'
const MIN_BUY_VALUE = Number(process.env.MIN_PURCHASE_VALUE ?? 100_000)

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const HOURS_BACK = Number(args[args.indexOf('--hours') + 1] ?? 24)

// ─── HTTP helper (no external deps) ──────────────────────────────────────────

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': SEC_UA, Accept: '*/*' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve(get(res.headers.location!))
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`))
        return
      }
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
  })
}

function post(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(SLACK_BOT_TOKEN ? { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } : {}),
      },
    }
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request(options, res => {
      let data = ''
      res.on('data', (c: string) => (data += c))
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── EDGAR data pipeline ──────────────────────────────────────────────────────

async function getRecentFilings(startDate: string, endDate: string): Promise<string[]> {
  const url =
    `https://efts.sec.gov/LATEST/search-index?forms=4` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
    `&hits.hits._source=accession_no`

  const json = JSON.parse(await get(url))
  const hits: { _source: { accession_no: string } }[] = json.hits?.hits ?? []
  return hits.map(h => h._source.accession_no)
}

function extractTag(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}>(?:<value>)?([^<]+)(?:<\\/value>)?<\\/${tag}>`))?.[1]?.trim() ?? ''
}

async function parseForm4(accNo: string): Promise<InsiderBuy[]> {
  const cik = accNo.split('-')[0].replace(/^0+/, '')
  const accNoClean = accNo.replace(/-/g, '')
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoClean}`

  // Find primary XML filename from filing index
  let xmlFile = `${accNo}.xml`
  try {
    const index = await get(`${base}/${accNo}-index.htm`)
    const m = index.match(/href="([^"]*\.xml)"/i)
    if (m) xmlFile = m[1].split('/').pop()!
  } catch { /* use default */ }

  const xml = await get(`${base}/${xmlFile}`)

  const company = extractTag(xml, 'issuerName')
  const ticker = extractTag(xml, 'issuerTradingSymbol')
  const insiderName = extractTag(xml, 'rptOwnerName')
  const officerTitle = extractTag(xml, 'officerTitle')
  const isDirector = xml.includes('<isDirector>1</isDirector>')
  const isOfficer = xml.includes('<isOfficer>1</isOfficer>')
  const title = officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? []
  const results: InsiderBuy[] = []

  for (const block of blocks) {
    const code = extractTag(block, 'transactionCode')
    const acqDisp = block.match(/<transactionAcquiredDisposedCode>\s*<value>([^<]+)<\/value>/)?.[1]?.trim()
    if (code !== 'P' && acqDisp !== 'A') continue

    const shares = parseFloat(block.match(/<transactionShares>\s*<value>([^<]+)<\/value>/)?.[1] ?? '0')
    const price = parseFloat(block.match(/<transactionPricePerShare>\s*<value>([^<]+)<\/value>/)?.[1] ?? '0')
    const date = block.match(/<transactionDate>\s*<value>([^<]+)<\/value>/)?.[1]?.trim() ?? ''
    const totalValue = shares * price

    if (totalValue < MIN_BUY_VALUE || shares <= 0 || price <= 0) continue

    results.push({ rank: 0, company, ticker, insiderName, title, shares, pricePerShare: price, totalValue, transactionDate: date, filingUrl: `${base}/` })
  }
  return results
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Slack payload ────────────────────────────────────────────────────────────

function fmt$(v: number) {
  return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1_000)}K`
}

function buildPayload(buys: InsiderBuy[], generatedAt: string) {
  const total = buys.reduce((s, b) => s + b.totalValue, 0)
  const rows = buys.slice(0, 15).map((b, i) => {
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
      { type: 'header', text: { type: 'plain_text', text: '📈 SEC Form 4 — Insider Purchases  |  Last 24 Hours', emoji: true } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*${buys.length} purchase${buys.length !== 1 ? 's' : ''}* above $100K  ·  Combined: *${fmt$(total)}*\n_${generatedAt}_`,
        },
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: rows.length ? rows.join('\n\n') : '_No qualifying purchases._' } },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Source: SEC EDGAR Form 4  ·  Ranked by total purchase value  ·  Directors & Officers only' }],
      },
    ],
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date()
  const from = new Date(now.getTime() - HOURS_BACK * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const generatedAt = now.toUTCString()

  console.log(`[scanner] Looking back ${HOURS_BACK}h · from ${fmt(from)} to ${fmt(now)}`)

  const accNos = await getRecentFilings(fmt(from), fmt(now))
  console.log(`[scanner] Found ${accNos.length} Form 4 filings`)

  const allBuys: InsiderBuy[] = []
  let parsed = 0

  for (let i = 0; i < accNos.length; i += 8) {
    const batch = accNos.slice(i, i + 8)
    const settled = await Promise.allSettled(batch.map(a => parseForm4(a)))
    for (const r of settled) {
      if (r.status === 'fulfilled') allBuys.push(...r.value)
      else console.warn('[scanner] parse error:', r.reason?.message)
    }
    parsed += batch.length
    if (i + 8 < accNos.length) await sleep(125) // respect SEC rate limit
  }

  allBuys.sort((a, b) => b.totalValue - a.totalValue)
  allBuys.forEach((b, i) => (b.rank = i + 1))

  console.log(`[scanner] Parsed ${parsed} filings · ${allBuys.length} buys > $${(MIN_BUY_VALUE / 1000).toFixed(0)}K`)
  allBuys.slice(0, 10).forEach(b =>
    console.log(`  #${b.rank} ${b.ticker || b.company} — ${b.insiderName} (${b.title}) — ${fmt$(b.totalValue)}`),
  )

  if (DRY_RUN) {
    console.log('[scanner] --dry-run: skipping Slack post')
    return
  }

  if (!SLACK_WEBHOOK_URL && !SLACK_BOT_TOKEN) {
    console.error('[scanner] Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN to enable Slack posting')
    process.exit(1)
  }

  const payload = buildPayload(allBuys, generatedAt)

  if (SLACK_WEBHOOK_URL) {
    const result = await post(SLACK_WEBHOOK_URL, JSON.stringify(payload))
    console.log('[scanner] Webhook response:', result)
  } else {
    const body = JSON.stringify({ channel: SLACK_CHANNEL_ID, ...payload })
    const result = JSON.parse(await post('https://slack.com/api/chat.postMessage', body))
    if (!result.ok) throw new Error(`Slack error: ${result.error}`)
    console.log('[scanner] Posted to Slack:', result.ts)
  }
}

main().catch(err => {
  console.error('[scanner] Fatal:', err)
  process.exit(1)
})
