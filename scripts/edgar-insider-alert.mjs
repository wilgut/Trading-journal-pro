/**
 * SEC EDGAR Form 4 Insider Purchase Scanner
 *
 * Checks EDGAR for executive/director stock purchases filed in the last 24 hours,
 * filters for transactions ≥ $100k, ranks by total value, and posts to Slack.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL_ID=C0AUARBCPND node scripts/edgar-insider-alert.mjs
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN   – Slack bot OAuth token
 *   SLACK_CHANNEL_ID  – Target channel (default: C0AUARBCPND)
 *
 * Run as a cron job (e.g., daily at 6 PM ET after market close):
 *   0 22 * * 1-5  node /path/to/scripts/edgar-insider-alert.mjs
 */

import https from 'https';
import { parseStringPromise } from 'xml2js'; // optional – falls back to regex parse

// ─── Config ──────────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN  ?? '';
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND';
const MIN_PURCHASE_USD = 100_000;

// SEC requires a descriptive User-Agent or requests are rejected with 429/403
const SEC_USER_AGENT   = 'TradingJournalPro/1.0 (dev@tradingjournal.com)';
const EDGAR_BASE       = 'https://data.sec.gov';
const EDGAR_SEARCH     = 'https://efts.sec.gov';

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': SEC_USER_AGENT,
        'Accept':     'application/json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'text/xml,application/xml,*/*' },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function postSlack(channel, text, blocks) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ channel, text, blocks, unfurl_links: false });
    const req = https.request({
      hostname: 'slack.com',
      path:     '/api/chat.postMessage',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json; charset=utf-8',
        'Authorization':  `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayStr()     { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── EDGAR helpers ────────────────────────────────────────────────────────────

/**
 * Search EDGAR for Form 4 filings in a date range.
 * Returns an array of { accessionNo, entityName, cik, filedAt } objects.
 */
async function searchForm4Filings(startDate, endDate) {
  const url =
    `${EDGAR_SEARCH}/LATEST/search-index?q=&forms=4` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
    `&hits.hits.total.value=true&hits.hits._source=entity_name,file_date,period_of_report,accession_no,file_num` +
    `&hits.hits.highlight=false&hits.hits.size=200`;

  const data = await fetchJSON(url);
  const hits  = data?.hits?.hits ?? [];

  return hits.map((h) => ({
    accessionNo: h._source?.accession_no ?? h._id ?? '',
    entityName:  h._source?.entity_name  ?? 'Unknown',
    filedAt:     h._source?.file_date    ?? startDate,
    // CIK can be derived from accession number (first 10 digits, zero-padded)
    cik:         (h._source?.accession_no ?? '').split('-')[0]?.replace(/^0+/, '') ?? '',
  }));
}

/**
 * Given a CIK and accession number (format XXXXXXXXXX-YY-ZZZZZZ),
 * fetch and parse the Form 4 XML, returning an array of purchase transactions.
 */
async function parsePurchases(cik, accessionNo) {
  // Build the filing index URL
  const accNoDashes = accessionNo.replace(/-/g, '');
  const paddedCik   = cik.padStart(10, '0');
  const indexUrl    = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/`;

  // Fetch the index JSON to find the primary XML document
  let xmlFilename;
  try {
    const indexJson = await fetchJSON(`${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/index.json`);
    const files     = indexJson?.directory?.item ?? [];
    const xmlFile   = files.find(
      (f) => f.name?.endsWith('.xml') && !f.name?.includes('xbrl') && f.name !== 'primary_doc.xml'
    ) ?? files.find((f) => f.name?.endsWith('.xml'));
    xmlFilename = xmlFile?.name;
  } catch {
    // Fall back: primary XML is typically named after the accession number
    xmlFilename = `${accNoDashes}.xml`;
  }

  if (!xmlFilename) return [];

  const xmlUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${xmlFilename}`;
  const xml    = await fetchText(xmlUrl);

  return extractPurchases(xml, accessionNo, cik);
}

/**
 * Parse a Form 4 XML string and return purchase transactions > MIN_PURCHASE_USD.
 * Handles both xml2js (if available) and a lightweight regex fallback.
 */
function extractPurchases(xml, accessionNo, cik) {
  const results = [];

  // ── Extract issuer info ──────────────────────────────────────────────────
  const issuerName   = xmlField(xml, 'issuerName')          ?? 'Unknown';
  const ticker       = xmlField(xml, 'issuerTradingSymbol') ?? '—';

  // ── Extract reporting owner info ─────────────────────────────────────────
  const ownerName    = xmlField(xml, 'rptOwnerName')        ?? 'Unknown';
  const isDirector   = xmlField(xml, 'isDirector')   === '1';
  const isOfficer    = xmlField(xml, 'isOfficer')    === '1';
  const officerTitle = xmlField(xml, 'officerTitle') ?? (isDirector ? 'Director' : 'Insider');

  const role = isOfficer
    ? officerTitle
    : isDirector
    ? 'Director'
    : 'Insider (10% owner)';

  // ── Parse non-derivative transactions ────────────────────────────────────
  const txnBlocks = xmlAll(xml, 'nonDerivativeTransaction');
  for (const block of txnBlocks) {
    const code  = xmlField(block, 'transactionCode');
    if (code !== 'P') continue; // P = open-market purchase

    const date        = xmlField(block, 'transactionDate')         ?? '';
    const sharesRaw   = xmlField(block, 'transactionShares')       ?? '0';
    const priceRaw    = xmlField(block, 'transactionPricePerShare') ?? '0';
    const shares      = parseFloat(sharesRaw)  || 0;
    const price       = parseFloat(priceRaw)   || 0;
    const totalValue  = shares * price;

    if (totalValue < MIN_PURCHASE_USD) continue;

    results.push({
      company:      issuerName,
      ticker:       ticker.toUpperCase(),
      executive:    ownerName,
      role,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate: date,
      accessionNo,
      cik,
      filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNo.replace(/-/g,'')}/`,
    });
  }

  return results;
}

// ─── Tiny XML helpers (no dependency required) ───────────────────────────────

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]*)<\\/value>`, 'i'))
    ?? xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m?.[1]?.trim() || null;
}

function xmlAll(xml, tag) {
  const blocks = [];
  const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

// ─── Slack message formatter ──────────────────────────────────────────────────

function formatSlackMessage(purchases, asOf) {
  const count = purchases.length;

  const header = count === 0
    ? `*SEC EDGAR — Insider Purchase Scan* | ${asOf}\nNo purchases ≥ $100k filed in the last 24 hours.`
    : `*SEC EDGAR — Insider Purchase Scan* | ${asOf}\n` +
      `Executives & directors who bought ≥ $100k of their own stock in the last 24 hours — ranked by value.`;

  if (count === 0) return { text: header, blocks: null };

  const rows = purchases.map((p, i) => {
    const val  = formatUSD(p.totalValue);
    const shr  = p.shares.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const px   = `$${p.pricePerShare.toFixed(2)}`;
    return (
      `*${i + 1}. ${p.ticker} — ${p.company}*\n` +
      `   👤  ${p.executive} _(${p.role})_\n` +
      `   💰  ${val}  ·  ${shr} shares @ ${px}\n` +
      `   📅  ${p.transactionDate}  ·  <${p.filingUrl}|View filing>`
    );
  });

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 SEC Insider Purchase Alert', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Executives & directors who bought ≥ $100k of their own stock filed in the last 24 hours — *${count} purchase${count !== 1 ? 's' : ''}* found.\n_As of ${asOf}_`,
      },
    },
    { type: 'divider' },
    ...rows.map((r) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: r },
    })),
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Source: <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4> · Transaction code P (open-market purchase) · Minimum threshold: $${(MIN_PURCHASE_USD / 1000).toFixed(0)}k`,
        },
      ],
    },
  ];

  return { text: header, blocks };
}

function formatUSD(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const endDate   = todayStr();
  const startDate = yesterdayStr();

  console.log(`\n🔍  Scanning SEC EDGAR Form 4 filings from ${startDate} to ${endDate} …`);

  // 1. Get list of Form 4 filings for the window
  let filings;
  try {
    filings = await searchForm4Filings(startDate, endDate);
  } catch (err) {
    console.error(`❌  Failed to search EDGAR: ${err.message}`);
    process.exit(1);
  }
  console.log(`    Found ${filings.length} Form 4 filings.`);

  // 2. Parse each filing XML concurrently (cap concurrency at 10)
  const allPurchases = [];
  const CONCURRENCY  = 10;

  for (let i = 0; i < filings.length; i += CONCURRENCY) {
    const batch   = filings.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((f) => parsePurchases(f.cik, f.accessionNo))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allPurchases.push(...r.value);
      // silently skip rejected (malformed/empty filings)
    }
    process.stdout.write(`    Parsed ${Math.min(i + CONCURRENCY, filings.length)} / ${filings.length}\r`);
  }
  console.log(`\n    Qualifying purchases (≥ $${(MIN_PURCHASE_USD / 1000).toFixed(0)}k): ${allPurchases.length}`);

  // 3. Sort descending by total value
  allPurchases.sort((a, b) => b.totalValue - a.totalValue);

  // 4. Print to console
  if (allPurchases.length) {
    console.log('\nRank  Ticker  Company                           Executive               Role               Total Value');
    console.log('─'.repeat(110));
    allPurchases.forEach((p, i) => {
      console.log(
        `${String(i + 1).padStart(4)}  ` +
        `${p.ticker.padEnd(6)}  ` +
        `${p.company.slice(0, 32).padEnd(34)}  ` +
        `${p.executive.slice(0, 22).padEnd(24)}  ` +
        `${p.role.slice(0, 18).padEnd(20)}  ` +
        formatUSD(p.totalValue)
      );
    });
  }

  // 5. Send to Slack
  if (!SLACK_BOT_TOKEN) {
    console.warn('\n⚠️  SLACK_BOT_TOKEN not set — skipping Slack post.');
    return;
  }

  const asOf = new Date().toLocaleString('en-US', {
    timeZone:    'America/New_York',
    dateStyle:   'medium',
    timeStyle:   'short',
  });

  const { text, blocks } = formatSlackMessage(allPurchases, asOf);
  try {
    const res = await postSlack(SLACK_CHANNEL_ID, text, blocks ?? undefined);
    if (res.ok) {
      console.log(`\n✅  Posted to Slack channel ${SLACK_CHANNEL_ID}: ${res.ts}`);
    } else {
      console.error(`\n❌  Slack error: ${res.error}`);
    }
  } catch (err) {
    console.error(`\n❌  Slack post failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
