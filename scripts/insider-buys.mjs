#!/usr/bin/env node
/**
 * SEC EDGAR Form 4 Insider Purchase Scanner
 * Fetches purchases >$100k filed in the last 24 hours and posts to Slack.
 *
 * Usage:
 *   node scripts/insider-buys.mjs
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... node scripts/insider-buys.mjs
 *   SLACK_CHANNEL=#trading SLACK_TOKEN=xoxb-... node scripts/insider-buys.mjs
 *
 * SEC Fair Access: https://www.sec.gov/os/accessing-edgar-data
 */

// ── Config ────────────────────────────────────────────────────────────────────
const USER_AGENT = 'TradingJournalPro ops@trading-journal-pro.com'; // SEC requires this
const MIN_VALUE   = 100_000;   // $100k threshold
const MAX_FILINGS = 300;       // cap to avoid hammering EDGAR
const TOP_N       = 25;        // results to include in the Slack summary
const BATCH_SIZE  = 8;         // concurrent filing fetches
const BATCH_DELAY = 800;       // ms between batches (SEC rate-limit: ≤10 req/s)

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/xml, text/html, */*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

function xmlVal(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<value>)?([^<]+?)(?:<\\/value>)?\\s*<\\/${tag}>`, 'is');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmt$  (n) { return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 }).format(n); }
function fmtNum(n) { return new Intl.NumberFormat('en-US').format(n); }
function fmt$2 (n) { return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', minimumFractionDigits:2, maximumFractionDigits:2 }).format(n); }

// ── Step 1: get recent Form 4 filing list ─────────────────────────────────────
// Primary: EDGAR EFTS full-text search (requires non-cloud IP per SEC Fair Access)
// Fallback: EDGAR daily-index flat files (tab-delimited, always public)
async function getRecentFilings() {
  const now       = new Date();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const startdt   = yesterday.toISOString().slice(0, 10);
  const enddt     = now.toISOString().slice(0, 10);

  // Try primary EFTS search API first
  try {
    const url  = `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}`;
    const text = await fetchText(url);
    const data = JSON.parse(text);
    const hits = (data.hits?.hits ?? []).slice(0, MAX_FILINGS);
    if (hits.length > 0) return { hits, startdt, enddt };
  } catch (e) {
    console.warn('  EFTS API unavailable, falling back to daily-index files…');
  }

  // Fallback: parse the daily flat-file index for each date in range
  const hits = [];
  for (const date of [startdt, enddt]) {
    const [yr, , ] = date.split('-');
    const quarter  = `QTR${Math.ceil(parseInt(date.slice(5, 7)) / 3)}`;
    const idxDate  = date.replace(/-/g, '');
    const url      = `https://www.sec.gov/Archives/edgar/daily-index/${yr}/${quarter}/form${idxDate}.idx`;
    try {
      const text = await fetchText(url);
      for (const line of text.split('\n')) {
        const cols = line.split('|');
        if (cols.length < 5) continue;
        const [companyName, formType, cik, fileDateRaw, filename] = cols;
        if (!formType?.trim().startsWith('4')) continue;
        const accNo = filename?.trim().replace('edgar/data/', '').split('/')[1]?.replace('.txt', '') ?? '';
        hits.push({ _source: { entity_name: companyName?.trim(), accession_no: accNo, cik: cik?.trim(), file_date: fileDateRaw?.trim() } });
      }
    } catch { /* date may not have an index yet */ }
  }

  return { hits: hits.slice(0, MAX_FILINGS), startdt, enddt };
}

// ── Step 2: resolve the actual Form 4 XML document URL ───────────────────────
async function resolveXmlUrl(accessionNo) {
  const clean = accessionNo.replace(/-/g, '');
  const cik   = accessionNo.split('-')[0].replace(/^0+/, '');
  const base  = `https://www.sec.gov/Archives/edgar/data/${cik}/${clean}`;
  const idx   = `${base}/${accessionNo}-index.htm`;

  let html;
  try { html = await fetchText(idx); } catch { return null; }

  // Primary document is almost always the first .xml link
  const m = html.match(/href="([^"]*\.xml[^"]*)"/i);
  if (!m) return null;
  return m[1].startsWith('http') ? m[1] : `https://www.sec.gov${m[1]}`;
}

// ── Step 3: parse Form 4 XML for qualifying purchases ────────────────────────
function parseForm4(xml, accessionNo) {
  const company  = xmlVal(xml, 'issuerName')          ?? 'Unknown';
  const ticker   = xmlVal(xml, 'issuerTradingSymbol') ?? '?';
  const insider  = xmlVal(xml, 'rptOwnerName')        ?? 'Unknown';

  const isDir    = xmlVal(xml, 'isDirector')  === '1';
  const isOff    = xmlVal(xml, 'isOfficer')   === '1';
  const offTitle = xmlVal(xml, 'officerTitle') ?? '';
  const title    = offTitle || (isDir && isOff ? 'Director & Officer' : isDir ? 'Director' : isOff ? 'Officer' : 'Insider');

  const cik      = accessionNo.split('-')[0].replace(/^0+/, '');
  const filingUrl= `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=10`;

  const results  = [];
  const TABLE_RE = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m;
  while ((m = TABLE_RE.exec(xml)) !== null) {
    const t = m[1];
    if (xmlVal(t, 'transactionCode')                    !== 'P') continue; // purchases only
    if (xmlVal(t, 'transactionAcquiredDisposedCode')    !== 'A') continue; // acquisitions only

    const shares = parseFloat(xmlVal(t, 'transactionShares')          ?? '0');
    const price  = parseFloat(xmlVal(t, 'transactionPricePerShare')   ?? '0');
    const date   = xmlVal(t, 'transactionDate') ?? '';
    const value  = shares * price;

    if (value < MIN_VALUE) continue;

    results.push({ company, ticker, insider, title, date, shares, price, value, filingUrl });
  }
  return results;
}

// ── Step 4: process a single filing ──────────────────────────────────────────
async function processFilig(filing) {
  const accessionNo = filing._source?.accession_no;
  if (!accessionNo) return [];
  try {
    const xmlUrl = await resolveXmlUrl(accessionNo);
    if (!xmlUrl) return [];
    const xml = await fetchText(xmlUrl);
    return parseForm4(xml, accessionNo);
  } catch {
    return [];
  }
}

// ── Step 5: format the Slack message ─────────────────────────────────────────
function buildSlackMessage(purchases, startdt, enddt) {
  if (purchases.length === 0) {
    return `*SEC Insider Buys >$100K — Last 24 Hours*\n_${startdt} → ${enddt}_\n\nNo qualifying purchases found.`;
  }

  const lines = purchases.slice(0, TOP_N).map((p, i) =>
    `*${i + 1}. ${p.ticker} — ${p.company}*\n` +
    `   👤 ${p.insider} _(${p.title})_\n` +
    `   📅 ${p.date}  |  💰 *${fmt$(p.value)}*  (${fmtNum(p.shares)} shares @ ${fmt$2(p.price)})\n` +
    `   🔗 <${p.filingUrl}|SEC Filing>`
  );

  return (
    `*📈 SEC EDGAR Insider Buys >$100K — Last 24 Hours*\n` +
    `_${startdt} → ${enddt} | ${purchases.length} qualifying purchase${purchases.length !== 1 ? 's' : ''}, showing top ${Math.min(purchases.length, TOP_N)}_\n\n` +
    lines.join('\n\n')
  );
}

// ── Step 6: send to Slack ─────────────────────────────────────────────────────
async function sendSlackWebhook(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
}

async function sendSlackApi(token, channel, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body   : JSON.stringify({ channel, text, mrkdwn: true }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Slack API error: ${body.error}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍  Fetching Form 4 filings from EDGAR…`);

  let filings, startdt, enddt;
  try {
    ({ hits: filings, startdt, enddt } = await getRecentFilings());
  } catch (e) {
    console.error('Failed to fetch filing list:', e.message);
    process.exit(1);
  }
  console.log(`    Found ${filings.length} filings (capped at ${MAX_FILINGS}) for ${startdt} → ${enddt}`);

  const allPurchases = [];
  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch   = filings.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(processFilig));
    allPurchases.push(...results.flat());
    process.stdout.write(`\r    Processed ${Math.min(i + BATCH_SIZE, filings.length)}/${filings.length} filings, ${allPurchases.length} purchases >$100K so far…`);
    if (i + BATCH_SIZE < filings.length) await sleep(BATCH_DELAY);
  }
  console.log();

  allPurchases.sort((a, b) => b.value - a.value);
  console.log(`\n✅  Found ${allPurchases.length} insider purchase(s) over $100K\n`);

  const message = buildSlackMessage(allPurchases, startdt, enddt);
  console.log('── Slack message preview ──────────────────────────────────────────');
  console.log(message);
  console.log('───────────────────────────────────────────────────────────────────\n');

  // Output JSON for programmatic use
  const jsonPath = '/tmp/insider-buys.json';
  const { writeFileSync } = await import('fs');
  writeFileSync(jsonPath, JSON.stringify(allPurchases, null, 2));
  console.log(`📄  Full results saved to ${jsonPath}`);

  // Slack delivery
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const slackToken = process.env.SLACK_TOKEN;
  const channel    = process.env.SLACK_CHANNEL ?? '#general';

  if (webhookUrl) {
    await sendSlackWebhook(webhookUrl, message);
    console.log('📨  Sent via Slack Incoming Webhook');
  } else if (slackToken) {
    await sendSlackApi(slackToken, channel, message);
    console.log(`📨  Sent to Slack channel ${channel}`);
  } else {
    console.log('ℹ️   No Slack credentials set. Export SLACK_WEBHOOK_URL or SLACK_TOKEN+SLACK_CHANNEL to deliver.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
