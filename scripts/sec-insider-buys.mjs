/**
 * SEC EDGAR Insider Purchase Scanner
 *
 * Fetches Form 4 filings from the last 24 hours, filters for executive/director
 * cash purchases >$100k, ranks by value, and posts a summary to Slack.
 *
 * Required env vars (one of the two Slack options):
 *   SLACK_WEBHOOK_URL             — Incoming Webhook URL
 *   SLACK_BOT_TOKEN + SLACK_CHANNEL_ID  — Bot token + channel
 *
 * Optional:
 *   SEC_USER_AGENT   — "CompanyName email@example.com" (SEC requires identification)
 *   MIN_PURCHASE_USD — Minimum purchase value in USD (default: 100000)
 *   DRY_RUN          — Set to "1" to print the message instead of sending to Slack
 */

const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data';
const USER_AGENT = process.env.SEC_USER_AGENT || 'TradingJournalPro research@tradingjournalpro.com';
const MIN_PURCHASE_USD = Number(process.env.MIN_PURCHASE_USD) || 100_000;
const DRY_RUN = process.env.DRY_RUN === '1';

// SEC rate limit: 10 req/s — we stay well under at ~6 req/s
const RATE_LIMIT_MS = 160;

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatCurrency(amount) {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

/** Extract all text between <tag>…</tag> occurrences as an array of strings. */
function extractBlocks(xml, tag) {
  const blocks = [];
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  let pos = 0;
  while (true) {
    const start = xml.indexOf(startTag, pos);
    if (start === -1) break;
    const end = xml.indexOf(endTag, start + startTag.length);
    if (end === -1) break;
    blocks.push(xml.slice(start + startTag.length, end));
    pos = end + endTag.length;
  }
  return blocks;
}

/**
 * Extract the text value of a tag from a block.
 * Handles both <tag>direct</tag> and <tag><value>nested</value></tag>.
 */
function extractValue(block, tag) {
  const inner = extractBlocks(block, tag)[0];
  if (!inner) return null;
  const valueBlock = extractBlocks(inner, 'value')[0];
  return (valueBlock ?? inner).trim();
}

// ─── SEC EDGAR: fetch filings list ───────────────────────────────────────────

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Fetch all Form 4 filings filed in the given date range from EDGAR full-text search.
 * Returns the raw search hits array.
 */
async function fetchForm4Filings(startDate, endDate) {
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  const allHits = [];
  let from = 0;
  const size = 40;
  let total = Infinity;

  while (from < total) {
    const url = `${EDGAR_SEARCH_URL}?q=&forms=4&dateRange=custom&startdt=${start}&enddt=${end}&from=${from}&size=${size}`;
    try {
      const res = await fetchWithRetry(url);
      const data = await res.json();
      total = data.hits?.total?.value ?? 0;
      const hits = data.hits?.hits ?? [];
      allHits.push(...hits);
      if (hits.length < size) break;
      from += size;
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`EDGAR search page from=${from} failed: ${err.message}`);
      break;
    }
  }

  return allHits;
}

// ─── SEC EDGAR: resolve XML URL for a filing ─────────────────────────────────

/**
 * From the accession number, try to derive the filer CIK.
 * Accession format: 0001234567-YY-NNNNNN — first segment is often the filer CIK.
 * Used as a fallback when entity_id is absent.
 */
function cikFromAccession(accessionNo) {
  return accessionNo.split('-')[0] ?? null;
}

/**
 * Fetch the filing index JSON and return the URL of the primary Form 4 XML.
 */
async function resolveXmlUrl(cik, accessionNo) {
  const accFormatted = accessionNo.replace(/-/g, '');
  const indexUrl = `${EDGAR_ARCHIVES_URL}/${cik}/${accFormatted}/${accessionNo}-index.json`;

  try {
    const res = await fetchWithRetry(indexUrl);
    const index = await res.json();
    const docs = index.documents ?? [];

    // Prefer the document explicitly typed "4"
    const primary = docs.find(d => d.type === '4' && d.document?.endsWith('.xml'))
      ?? docs.find(d => d.document?.endsWith('.xml'));

    if (primary) {
      return `${EDGAR_ARCHIVES_URL}/${cik}/${accFormatted}/${primary.document}`;
    }
  } catch {
    // Ignore index fetch failures — the caller will skip this filing
  }
  return null;
}

// ─── Form 4 XML parser ───────────────────────────────────────────────────────

/**
 * Parse a Form 4 XML string and return an array of purchase records.
 * Only returns non-derivative cash purchases (transaction code "P").
 */
function parseForm4(xml, entityName, displayNames, fileDate) {
  const issuerName = extractValue(xml, 'issuerName') || entityName || 'Unknown';
  const ticker = extractValue(xml, 'issuerTradingSymbol') || '';

  // Owner identity — use first reporting owner
  const ownerBlock = extractBlocks(xml, 'reportingOwner')[0] ?? xml;
  const ownerName =
    extractValue(ownerBlock, 'rptOwnerName') ||
    (displayNames?.[0] ?? '').split(' (')[0] ||
    'Unknown';

  const relBlock = extractBlocks(ownerBlock, 'reportingOwnerRelationship')[0] ?? '';
  const isDirector = extractValue(relBlock, 'isDirector') === '1';
  const isOfficer = extractValue(relBlock, 'isOfficer') === '1';
  const officerTitle = extractValue(relBlock, 'officerTitle') || '';
  const role = isOfficer && officerTitle
    ? officerTitle
    : isDirector ? 'Director'
    : isOfficer ? 'Officer'
    : 'Insider';

  const purchases = [];

  for (const txnBlock of extractBlocks(xml, 'nonDerivativeTransaction')) {
    const code = extractValue(txnBlock, 'transactionCode');
    const acquired = extractValue(txnBlock, 'transactionAcquiredDisposedCode');

    if (code !== 'P' || acquired !== 'A') continue;

    const sharesStr = extractValue(txnBlock, 'transactionShares');
    const priceStr = extractValue(txnBlock, 'transactionPricePerShare');

    const shares = parseFloat(sharesStr ?? '');
    const price = parseFloat(priceStr ?? '');

    if (!isFinite(shares) || !isFinite(price) || price <= 0 || shares <= 0) continue;

    purchases.push({
      issuerName,
      ticker: ticker.trim(),
      ownerName: ownerName.trim(),
      role,
      shares,
      price,
      totalValue: shares * price,
      securityTitle: extractValue(txnBlock, 'securityTitle') || 'Common Stock',
      transactionDate: extractValue(txnBlock, 'transactionDate') || fileDate,
      fileDate,
    });
  }

  return purchases;
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

async function processFilings(filings) {
  const allPurchases = [];
  const total = filings.length;

  for (let i = 0; i < total; i++) {
    const { _source: src } = filings[i];
    const accessionNo = src?.accession_no;
    // entity_id is the filer CIK when present; fall back to accession prefix
    const cik = src?.entity_id || cikFromAccession(accessionNo ?? '');

    if (!accessionNo || !cik) continue;

    try {
      await sleep(RATE_LIMIT_MS);
      const xmlUrl = await resolveXmlUrl(cik, accessionNo);
      if (!xmlUrl) continue;

      await sleep(RATE_LIMIT_MS);
      const xmlRes = await fetchWithRetry(xmlUrl);
      const xml = await xmlRes.text();

      const purchases = parseForm4(
        xml,
        src.entity_name ?? '',
        src.display_names ?? [],
        (src.file_date ?? '').split('T')[0],
      );
      allPurchases.push(...purchases);
    } catch {
      // Skip failed filings silently — they're rare but expected
    }

    if ((i + 1) % 50 === 0 || i + 1 === total) {
      process.stdout.write(`\r  Processed ${i + 1}/${total} filings — ${allPurchases.length} purchases found`);
    }
  }

  if (total > 0) console.log(); // newline after progress
  return allPurchases;
}

/**
 * Aggregate purchases by (issuerName, ownerName) so multiple transactions
 * from the same person on the same day are combined into one entry.
 */
function aggregatePurchases(purchases) {
  const map = new Map();

  for (const p of purchases) {
    const key = `${p.issuerName}::${p.ownerName}`;
    if (map.has(key)) {
      const existing = map.get(key);
      existing.totalValue += p.totalValue;
      existing.shares += p.shares;
      // Keep the latest price (approximate — weighted avg would require more data)
      existing.price = p.price;
    } else {
      map.set(key, { ...p });
    }
  }

  return [...map.values()];
}

// ─── Slack notification ───────────────────────────────────────────────────────

function buildSlackText(purchases, dateRange) {
  const header = `📊 *SEC Insider Purchases — Last 24 Hours*\n_${dateRange} · Cash purchases >$${(MIN_PURCHASE_USD / 1000).toFixed(0)}K by executives & directors_`;

  if (purchases.length === 0) {
    return `${header}\n\n_No qualifying insider purchases found for this period._`;
  }

  const top = purchases.slice(0, 20);
  const rows = top.map((p, i) => {
    const tickerStr = p.ticker ? ` *(${p.ticker})*` : '';
    return [
      `*${i + 1}.* ${p.ownerName} — ${p.role}`,
      `   🏢 ${p.issuerName}${tickerStr}`,
      `   💰 ${p.shares.toLocaleString(undefined, { maximumFractionDigits: 0 })} shares @ $${p.price.toFixed(2)} = *${formatCurrency(p.totalValue)}*`,
      `   📅 Txn: ${p.transactionDate}  |  Filed: ${p.fileDate}`,
    ].join('\n');
  });

  const footer = purchases.length > 20
    ? `_Showing top 20 of ${purchases.length} qualifying purchases, ranked by value._`
    : `_Total: ${purchases.length} insider purchase${purchases.length === 1 ? '' : 's'} above $${(MIN_PURCHASE_USD / 1000).toFixed(0)}K_`;

  return [header, '', ...rows, '', footer].join('\n');
}

async function sendToSlack(text) {
  if (DRY_RUN) {
    console.log('\n─── Slack message (DRY RUN) ───────────────────────────\n');
    console.log(text);
    console.log('\n───────────────────────────────────────────────────────\n');
    return;
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!webhookUrl && !(botToken && channelId)) {
    console.warn('[warn] No Slack credentials set. Printing message instead.\n');
    console.log(text);
    console.warn(
      '\nSet SLACK_WEBHOOK_URL  —or—  SLACK_BOT_TOKEN + SLACK_CHANNEL_ID to send to Slack.',
    );
    return;
  }

  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mrkdwn: true }),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
    console.log('✓ Message sent via Slack Incoming Webhook');
  } else {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    console.log(`✓ Message sent to Slack channel ${channelId}`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateRange = `${formatDate(since)} → ${formatDate(now)}`;

  console.log(`\nSEC EDGAR Insider Purchase Scanner`);
  console.log(`Period : ${dateRange}`);
  console.log(`Filter : cash purchases > $${MIN_PURCHASE_USD.toLocaleString()}`);
  if (DRY_RUN) console.log(`Mode   : DRY RUN (Slack disabled)\n`);

  console.log('\n[1/3] Fetching Form 4 filings from EDGAR…');
  const filings = await fetchForm4Filings(since, now);
  console.log(`  Found ${filings.length} Form 4 filings`);

  if (filings.length === 0) {
    const text = buildSlackText([], dateRange);
    await sendToSlack(text);
    return;
  }

  console.log('\n[2/3] Parsing filings for insider purchases…');
  const rawPurchases = await processFilings(filings);

  // Aggregate, filter, rank
  const purchases = aggregatePurchases(rawPurchases)
    .filter(p => p.totalValue >= MIN_PURCHASE_USD)
    .sort((a, b) => b.totalValue - a.totalValue);

  console.log(`  Qualifying purchases (>${formatCurrency(MIN_PURCHASE_USD)}): ${purchases.length}`);

  if (purchases.length > 0) {
    console.log('\n  Top 5 preview:');
    purchases.slice(0, 5).forEach((p, i) => {
      const ticker = p.ticker ? ` (${p.ticker})` : '';
      console.log(`    ${i + 1}. ${p.ownerName} — ${p.issuerName}${ticker} — ${formatCurrency(p.totalValue)}`);
    });
  }

  console.log('\n[3/3] Sending summary to Slack…');
  const text = buildSlackText(purchases, dateRange);
  await sendToSlack(text);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
