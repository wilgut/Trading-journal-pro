#!/usr/bin/env node
/**
 * Standalone insider-buying alert.
 * Run directly:  node scripts/insider-buying-alert.mjs
 * Cron example:  0 * * * * node /path/scripts/insider-buying-alert.mjs
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL  — incoming-webhook URL to post the summary
 */

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data'
const MIN_VALUE_USD = 100_000
const USER_AGENT = 'TradingJournalPro/1.0 admin@tradingjournalpro.com'
const RATE_LIMIT_MS = 120

// ── XML helpers ────────────────────────────────────────────────────────────────

function xmlVal(xml, tag) {
  let m = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<value>([^<]*)</value>`, 'i'))
  if (m) return m[1].trim()
  m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function xmlBlocks(xml, tag) {
  const results = []
  const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi')
  let m
  while ((m = re.exec(xml)) !== null) results.push(m[0])
  return results
}

function xmlBlock(xml, tag) {
  return xmlBlocks(xml, tag)[0] ?? ''
}

// ── EDGAR helpers ──────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

function cikFromAccession(accession) {
  return accession.split('-')[0].replace(/^0+/, '') || '0'
}

function nodashAccession(accession) {
  return accession.replace(/-/g, '')
}

async function fetchWithUA(url) {
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
}

async function fetchForm4XML(cik, accession) {
  const nodash = nodashAccession(accession)
  const base = `${EDGAR_ARCHIVES}/${cik}/${nodash}`

  try {
    const indexRes = await fetchWithUA(`${base}/index.json`)
    if (indexRes.ok) {
      const idx = await indexRes.json()
      const items = idx.directory?.item ?? []
      const xmlFile = items.find(
        f => f.name.endsWith('.xml') && !/\.(xsd|xsl)/.test(f.name)
      )
      if (xmlFile) {
        const xmlRes = await fetchWithUA(`${base}/${xmlFile.name}`)
        if (xmlRes.ok) return xmlRes.text()
      }
    }
  } catch {}

  for (const name of [`${accession}.xml`, 'form4.xml', 'wf-form4.xml']) {
    try {
      const res = await fetchWithUA(`${base}/${name}`)
      if (res.ok) return res.text()
    } catch {}
  }

  return null
}

// ── Form 4 parser ──────────────────────────────────────────────────────────────

function parseForm4(xml, filingDate, accession) {
  const purchases = []

  const issuerBlock = xmlBlock(xml, 'issuer')
  const company = xmlVal(issuerBlock, 'issuerName') || xmlVal(xml, 'issuerName')
  const ticker = xmlVal(issuerBlock, 'issuerTradingSymbol') || xmlVal(xml, 'issuerTradingSymbol')

  const ownerBlock = xmlBlock(xml, 'reportingOwner')
  const insiderName = xmlVal(ownerBlock, 'rptOwnerName') || xmlVal(xml, 'rptOwnerName')
  const relBlock = xmlBlock(xml, 'reportingOwnerRelationship')

  const isDirector = xmlVal(relBlock, 'isDirector') === '1'
  const isOfficer = xmlVal(relBlock, 'isOfficer') === '1'
  if (!isDirector && !isOfficer) return purchases

  const officerTitle = xmlVal(relBlock, 'officerTitle')
  const insiderTitle = isOfficer && officerTitle
    ? officerTitle
    : isDirector ? 'Director' : 'Insider'

  for (const tx of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const code = xmlVal(xmlBlock(tx, 'transactionCoding'), 'transactionCode')
      || xmlVal(tx, 'transactionCode')
    const adCode = xmlVal(tx, 'transactionAcquiredDisposedCode')

    if (code !== 'P' || adCode !== 'A') continue

    const shares = parseFloat(xmlVal(tx, 'transactionShares') || '0')
    const price = parseFloat(xmlVal(tx, 'transactionPricePerShare') || '0')
    if (!shares || !price) continue

    const totalValue = shares * price
    if (totalValue < MIN_VALUE_USD) continue

    purchases.push({
      company: company || 'Unknown Company',
      ticker: ticker || '',
      insiderName: insiderName || 'Unknown',
      insiderTitle,
      shares,
      pricePerShare: price,
      totalValue,
      filingDate,
      accessionNumber: accession,
    })
  }

  return purchases
}

// ── Slack ──────────────────────────────────────────────────────────────────────

function formatMoney(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

async function sendSlackSummary(purchases, dateRange, processedCount) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    console.log('SLACK_WEBHOOK_URL not set — skipping Slack notification')
    return
  }

  const lines = [
    '*📈 Insider Buying Alert — Last 24 Hours*',
    `_Open-market purchases >$100K by executives & directors_`,
    `_Filings processed: ${processedCount} | Window: ${dateRange.from} → ${dateRange.to}_`,
    '',
  ]

  if (purchases.length === 0) {
    lines.push('No significant insider purchases found in this window.')
  } else {
    purchases.forEach((p, i) => {
      const co = p.ticker ? `${p.company} (${p.ticker})` : p.company
      lines.push(
        `*${i + 1}. ${co}* — ${p.insiderName}, _${p.insiderTitle}_`,
        `   ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${formatMoney(p.totalValue)}*`,
        `   Filed: ${p.filingDate}`,
        ''
      )
    })
  }

  const text = lines.join('\n')
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  console.log('Slack message sent.')
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const startDate = yesterday.toISOString().split('T')[0]
  const endDate = now.toISOString().split('T')[0]

  console.log(`Fetching Form 4 filings: ${startDate} → ${endDate}`)

  const searchUrl =
    `${EDGAR_SEARCH}?forms=4&dateRange=custom` +
    `&startdt=${startDate}&enddt=${endDate}&from=0&size=100`

  const searchRes = await fetchWithUA(searchUrl)
  if (!searchRes.ok) {
    console.error(`EDGAR search failed: HTTP ${searchRes.status}`)
    process.exit(1)
  }
  const data = await searchRes.json()
  const filings = data.hits?.hits ?? []
  console.log(`Found ${filings.length} Form 4 filings`)

  const allPurchases = []

  for (let i = 0; i < filings.length; i++) {
    const filing = filings[i]
    const accession = filing._id
    const filingDate = filing._source.file_date
    const cik = cikFromAccession(accession)

    process.stdout.write(`\r  Processing ${i + 1}/${filings.length}…`)
    await sleep(RATE_LIMIT_MS)

    try {
      const xml = await fetchForm4XML(cik, accession)
      if (!xml) continue
      allPurchases.push(...parseForm4(xml, filingDate, accession))
    } catch {
      // skip individual failures
    }
  }
  process.stdout.write('\n')

  const ranked = allPurchases
    .filter(p => p.totalValue >= MIN_VALUE_USD)
    .sort((a, b) => b.totalValue - a.totalValue)

  console.log(`\nSignificant insider purchases (>$100K): ${ranked.length}`)
  ranked.forEach((p, i) => {
    const co = p.ticker ? `${p.company} (${p.ticker})` : p.company
    console.log(
      `  ${i + 1}. ${co} — ${p.insiderName} (${p.insiderTitle}): ` +
      `${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = ${formatMoney(p.totalValue)}`
    )
  })

  await sendSlackSummary(ranked, { from: startDate, to: endDate }, filings.length)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
