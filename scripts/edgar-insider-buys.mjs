#!/usr/bin/env node
/**
 * Standalone runner: fetch SEC EDGAR Form 4 insider purchases from the last
 * 24 hours, filter for >$100k buys, rank by size, and post to Slack.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... node scripts/edgar-insider-buys.mjs
 *
 * Cron (daily at 6 AM):
 *   0 6 * * * cd /app && SLACK_BOT_TOKEN=xoxb-... node scripts/edgar-insider-buys.mjs
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN  – required; Slack bot token with chat:write scope
 *   SLACK_CHANNEL_ID – optional; defaults to #sec-form4-insider-scanner (C0AUARBCPND)
 */

import { setTimeout as sleep } from 'node:timers/promises'

const EFTS_BASE      = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVE  = 'https://www.sec.gov/Archives'
const SLACK_API      = 'https://slack.com/api/chat.postMessage'
const UA             = 'TradingJournalPro/1.0 admin@tradingjournalpro.com'
const MIN_VALUE      = 100_000
const BATCH_SIZE     = 8
const BATCH_DELAY_MS = 1100   // keep under SEC's 10 req/sec guideline

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmtCurrency(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

// ─── EDGAR parsing ────────────────────────────────────────────────────────────
function parseForm4Buys(xml) {
  const buys = []

  const company = xml.match(/<issuerName>([^<]+)<\/issuerName>/)?.[1]?.trim() ?? 'Unknown'
  const ticker  = xml.match(/<issuerTradingSymbol>([^<]+)<\/issuerTradingSymbol>/)?.[1]?.trim().toUpperCase() ?? ''
  const insider = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/)?.[1]?.trim() ?? 'Unknown'

  const officerTitle  = xml.match(/<officerTitle>([^<]+)<\/officerTitle>/)?.[1]?.trim()
  const isDirector    = /<isDirector>1<\/isDirector>/.test(xml)
  const isOfficer     = /<isOfficer>1<\/isOfficer>/.test(xml)
  const insiderTitle  =
    officerTitle ||
    (isDirector && isOfficer ? 'Director & Officer' : isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider')

  const txRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g
  let m
  while ((m = txRe.exec(xml)) !== null) {
    const tx = m[1]

    const code = tx.match(/<transactionCode>([^<]+)<\/transactionCode>/)?.[1]?.trim()
    if (code !== 'P') continue
    const ad = tx.match(/<transactionAcquiredDisposedCode>\s*<value>([^<]+)<\/value>/)?.[1]?.trim()
    if (ad !== 'A') continue

    const shares = parseFloat(tx.match(/<transactionShares>\s*<value>([\d.,]+)<\/value>/)?.[1]?.replace(/,/g, '') ?? '0')
    const price  = parseFloat(tx.match(/<transactionPricePerShare>\s*<value>([\d.,]+)<\/value>/)?.[1]?.replace(/,/g, '') ?? '0')
    const txDate = tx.match(/<transactionDate>\s*<value>([^<]+)<\/value>/)?.[1]?.trim() ?? ''

    if (shares <= 0 || price <= 0) continue
    const total = shares * price
    if (total < MIN_VALUE) continue

    const existing = buys.find(b => b.companyName === company && b.insiderName === insider)
    if (existing) {
      existing.shares     += shares
      existing.totalValue += total
      existing.pricePerShare = existing.totalValue / existing.shares
    } else {
      buys.push({ companyName: company, ticker, insiderName: insider, insiderTitle, shares, pricePerShare: price, totalValue: total, transactionDate: txDate })
    }
  }
  return buys
}

// ─── EDGAR HTTP ───────────────────────────────────────────────────────────────
async function fetchFilingXML(hit) {
  const headers = { 'User-Agent': UA }

  const id = hit._id ?? ''
  if (id && !id.endsWith('-index.htm')) {
    try {
      const r = await fetch(`${EDGAR_ARCHIVE}/${id}`, { headers })
      if (r.ok) {
        const t = await r.text()
        if (t.includes('<ownershipDocument>')) return t
      }
    } catch { /* fall through */ }
  }

  const accNo = hit._source?.accession_no ?? ''
  if (!accNo) return null

  const rawCik = (hit._source?.display_names?.[0] ?? '').match(/CIK (\d+)/i)?.[1] ?? accNo.split('-')[0]
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
    const xmlName = idx.directory?.item?.find(f => f.type === '4' && f.name.endsWith('.xml'))?.name
    if (!xmlName) return null

    const r = await fetch(`${EDGAR_ARCHIVE}/edgar/data/${cik}/${accNoDash}/${xmlName}`, { headers })
    if (!r.ok) return null
    const t = await r.text()
    return t.includes('<ownershipDocument>') ? t : null
  } catch {
    return null
  }
}

async function batchProcess(items, fn, size = BATCH_SIZE) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size)
    out.push(...(await Promise.all(batch.map(fn))))
    if (i + size < items.length) await sleep(BATCH_DELAY_MS)
  }
  return out
}

// ─── Slack ────────────────────────────────────────────────────────────────────
async function postToSlack(text) {
  const token   = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND'
  if (!token) {
    console.warn('[edgar-insider-buys] SLACK_BOT_TOKEN not set — printing message instead:\n')
    console.log(text)
    return { ok: false, error: 'missing_token' }
  }
  const res = await fetch(SLACK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  })
  const data = await res.json()
  if (!data.ok) console.error('[edgar-insider-buys] Slack error:', data.error)
  return data
}

function buildSlackMessage(buys, startDate, endDate) {
  const top  = buys.slice(0, 20)
  const rows = top.map((b, i) => {
    const tick = b.ticker ? ` (${b.ticker})` : ''
    return [
      `*${i + 1}. ${b.companyName}${tick}*`,
      `   ${b.insiderName} — ${b.insiderTitle}`,
      `   ${fmtCurrency(b.totalValue)} · ${b.shares.toLocaleString()} shares @ $${b.pricePerShare.toFixed(2)}`,
      `   Date: ${b.transactionDate}`,
    ].join('\n')
  }).join('\n\n')

  return [
    `:chart_with_upwards_trend: *SEC EDGAR Insider Buys — Last 24 Hours* (>${fmtCurrency(MIN_VALUE)} threshold)`,
    `_${startDate} → ${endDate}  ·  ${buys.length} qualifying purchase${buys.length !== 1 ? 's' : ''} found_`,
    '',
    rows,
    '',
    `_Source: SEC EDGAR Form 4 filings_`,
  ].join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now       = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startDate = yesterday.toISOString().slice(0, 10)
  const endDate   = now.toISOString().slice(0, 10)

  console.log(`[edgar-insider-buys] Scanning Form 4 filings ${startDate} → ${endDate}`)

  const searchRes = await fetch(
    `${EFTS_BASE}?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&from=0&size=200`,
    { headers: { 'User-Agent': UA } },
  )
  if (!searchRes.ok) throw new Error(`EDGAR EFTS responded with ${searchRes.status}`)

  const searchData = await searchRes.json()
  const hits = searchData.hits?.hits ?? []
  console.log(`[edgar-insider-buys] ${hits.length} Form 4 filings returned`)

  if (hits.length === 0) {
    await postToSlack(`No Form 4 filings found between ${startDate} and ${endDate}.`)
    return
  }

  const xmlDocs = await batchProcess(hits, fetchFilingXML, BATCH_SIZE)

  const allBuys = []
  hits.forEach((hit, i) => {
    const xml = xmlDocs[i]
    if (!xml) return
    const filingDate = hit._source?.file_date ?? endDate
    const parsed = parseForm4Buys(xml)
    parsed.forEach(b => { if (!b.transactionDate) b.transactionDate = filingDate })
    allBuys.push(...parsed)
  })

  allBuys.sort((a, b) => b.totalValue - a.totalValue)
  console.log(`[edgar-insider-buys] ${allBuys.length} purchases over ${fmtCurrency(MIN_VALUE)} found`)

  if (allBuys.length === 0) {
    await postToSlack(`:mag: No insider purchases over ${fmtCurrency(MIN_VALUE)} found in the last 24 hours.`)
    return
  }

  const message = buildSlackMessage(allBuys, startDate, endDate)
  const result  = await postToSlack(message)
  console.log(`[edgar-insider-buys] Slack post ${result.ok ? 'succeeded' : 'failed: ' + result.error}`)
}

main().catch(err => {
  console.error('[edgar-insider-buys] Fatal error:', err)
  process.exit(1)
})
