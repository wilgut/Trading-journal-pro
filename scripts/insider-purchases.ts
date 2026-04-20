#!/usr/bin/env npx tsx
/**
 * SEC EDGAR Insider Purchase Monitor
 *
 * Fetches Form 4 filings from the last 24 hours, filters for significant
 * purchases (>$100k) by executives and directors, ranks them by total value,
 * and posts a summary to Slack.
 *
 * Usage:
 *   npx tsx scripts/insider-purchases.ts
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... npx tsx scripts/insider-purchases.ts
 *
 * EDGAR rate-limit: 10 req/sec max. We stay well under at ~6/sec.
 */

const EDGAR_ATOM_URL =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=100&output=atom';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const MIN_PURCHASE_VALUE = Number(process.env.EDGAR_MIN_PURCHASE ?? 100_000);
const RATE_LIMIT_MS = 160; // ~6 req/sec
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';
// EDGAR requires a descriptive User-Agent with contact info
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ?? 'TradingJournalPro research@example.com';

// ── Types ────────────────────────────────────────────────────────────────────

interface FilingRef {
  /** CIK of the physical filer (first 10 digits of accession number). */
  filerCik: string;
  /** Accession number with dashes, e.g. "0001209191-24-012345". */
  acc: string;
  /** Timestamp the filing appeared in the feed. */
  updated: Date;
}

interface InsiderPurchase {
  filerName: string;
  title: string;
  company: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  txDate: string;
  filingUrl: string;
}

// ── XML helpers (regex-based, no extra deps) ─────────────────────────────────

function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchText(url: string): Promise<string> {
  await sleep(RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml,text/xml,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ── EDGAR: collect recent Form 4 filing references ───────────────────────────

async function getRecentFilings(): Promise<FilingRef[]> {
  const feed = await fetchText(EDGAR_ATOM_URL);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const entries = xmlBlocks(feed, 'entry');

  const refs: FilingRef[] = [];
  for (const entry of entries) {
    const updatedStr = xmlTag(entry, 'updated');
    if (!updatedStr) continue;
    const updated = new Date(updatedStr);
    if (updated < cutoff) continue; // Outside 24-hour window

    // <id>urn:tag:sec.gov,2008:accession-number=0001209191-24-012345</id>
    const idStr = xmlTag(entry, 'id');
    const accMatch = idStr.match(/accession-number=(\d{10}-\d{2}-\d{6})/);
    if (!accMatch) continue;
    const acc = accMatch[1];

    // First 10 digits of accession number = filer CIK (strip leading zeros)
    const filerCik = String(Number(acc.slice(0, 10)));

    refs.push({ filerCik, acc, updated });
  }
  return refs;
}

// ── EDGAR: resolve accession number → primary Form 4 XML URL ─────────────────

async function resolveXmlUrl(ref: FilingRef): Promise<string | null> {
  const accNoDashes = ref.acc.replace(/-/g, '');
  const indexUrl = `${EDGAR_ARCHIVES}/${ref.filerCik}/${accNoDashes}/${ref.acc}-index.htm`;

  let html: string;
  try {
    html = await fetchText(indexUrl);
  } catch {
    return null;
  }

  // The index table lists files; pick the first .xml link that isn't an xsd/stylesheet
  const xmlMatch = html.match(/href="([^"]+\.xml)"[^>]*>(?!.*schema|.*xsd)/i)
    ?? html.match(/href="([^"]+\.xml)"/i);
  if (!xmlMatch) return null;

  const path = xmlMatch[1];
  return path.startsWith('http') ? path : `https://www.sec.gov${path}`;
}

// ── EDGAR: parse a Form 4 XML document ───────────────────────────────────────

function parseForm4(xml: string, filingUrl: string): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = [];

  const issuer = xmlTag(xml, 'issuer');
  const company = xmlTag(issuer, 'issuerName');
  const ticker = xmlTag(issuer, 'issuerTradingSymbol').toUpperCase();

  const owner = xmlTag(xml, 'reportingOwner');
  const filerName = xmlTag(xmlTag(owner, 'reportingOwnerId'), 'rptOwnerName');
  const rel = xmlTag(owner, 'reportingOwnerRelationship');
  const isDirector = xmlTag(rel, 'isDirector') === '1';
  const isOfficer = xmlTag(rel, 'isOfficer') === '1';
  const officerTitle = xmlTag(rel, 'officerTitle');

  // Only track named insiders (director or officer)
  if (!isDirector && !isOfficer) return [];

  const title = officerTitle || (isDirector ? 'Director' : 'Insider');

  // Non-derivative (direct stock) transactions
  const ndTable = xmlTag(xml, 'nonDerivativeTable');
  const txns = xmlBlocks(ndTable, 'nonDerivativeTransaction');

  for (const txn of txns) {
    if (xmlTag(txn, 'transactionCode') !== 'P') continue; // P = open-market purchase

    const sharesStr = xmlTag(xmlTag(txn, 'transactionShares'), 'value') || xmlTag(txn, 'transactionShares');
    const priceStr =
      xmlTag(xmlTag(txn, 'transactionPricePerShare'), 'value') ||
      xmlTag(txn, 'transactionPricePerShare');
    const dateStr = xmlTag(xmlTag(txn, 'transactionDate'), 'value') || xmlTag(txn, 'transactionDate');

    const shares = parseFloat(sharesStr);
    const price = parseFloat(priceStr);
    if (!isFinite(shares) || !isFinite(price) || shares <= 0 || price <= 0) continue;

    purchases.push({
      filerName,
      title,
      company,
      ticker,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      txDate: dateStr,
      filingUrl,
    });
  }

  return purchases;
}

// ── Slack ─────────────────────────────────────────────────────────────────────

function fmt$(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value).toLocaleString()}`;
}

function buildSlackPayload(purchases: InsiderPurchase[]): object {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const shown = purchases.slice(0, 20);
  const overflow = purchases.length - shown.length;

  const header = `*SEC Insider Purchases ≥${fmt$(MIN_PURCHASE_VALUE)} — ${date}*\n_${purchases.length} significant purchase${purchases.length !== 1 ? 's' : ''} found_\n`;

  const rows = shown.map((p, i) => {
    const rank = `${i + 1}.`;
    const value = `*${fmt$(p.totalValue)}*`;
    const shares = `${p.shares.toLocaleString('en-US')} sh @ $${p.pricePerShare.toFixed(2)}`;
    return (
      `${rank} *${p.ticker}* — ${p.filerName} (${p.title})\n` +
      `   ${value} · ${shares} · ${p.company}\n` +
      `   <${p.filingUrl}|View Filing>`
    );
  });

  const footer = overflow > 0 ? `\n_…and ${overflow} more not shown_` : '';

  return {
    text: header + rows.join('\n\n') + footer,
    unfurl_links: false,
  };
}

async function sendToSlack(purchases: InsiderPurchase[]): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log('\n── No SLACK_WEBHOOK_URL set. Printing summary to stdout ──\n');
    printSummary(purchases);
    return;
  }
  const body = buildSlackPayload(purchases);
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
  console.log(`Sent ${purchases.length} purchases to Slack.`);
}

function printSummary(purchases: InsiderPurchase[]): void {
  if (purchases.length === 0) {
    console.log('No significant insider purchases in the last 24 hours.');
    return;
  }
  console.log(`Rank  Ticker  Value         Shares @ Price    Name (Title)               Company`);
  console.log('─'.repeat(100));
  purchases.slice(0, 20).forEach((p, i) => {
    const rank = String(i + 1).padEnd(5);
    const ticker = p.ticker.padEnd(7);
    const val = fmt$(p.totalValue).padEnd(13);
    const trade = `${p.shares.toLocaleString()} @ $${p.pricePerShare.toFixed(2)}`.padEnd(18);
    const name = `${p.filerName} (${p.title})`.slice(0, 28).padEnd(28);
    console.log(`${rank} ${ticker} ${val} ${trade} ${name} ${p.company}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Fetching recent Form 4 filings from SEC EDGAR…');
  const filings = await getRecentFilings();
  console.log(`  → ${filings.length} Form 4 filing(s) in the last 24 hours`);

  const allPurchases: InsiderPurchase[] = [];
  let processed = 0;
  let errors = 0;

  for (const ref of filings) {
    try {
      const xmlUrl = await resolveXmlUrl(ref);
      if (!xmlUrl) { errors++; continue; }

      const accNoDashes = ref.acc.replace(/-/g, '');
      const indexUrl = `${EDGAR_ARCHIVES}/${ref.filerCik}/${accNoDashes}/${ref.acc}-index.htm`;

      const xml = await fetchText(xmlUrl);
      const purchases = parseForm4(xml, indexUrl);
      allPurchases.push(...purchases);
      processed++;

      if (processed % 10 === 0) process.stdout.write(`\r  → Processed ${processed}/${filings.length}…`);
    } catch {
      errors++;
    }
  }

  process.stdout.write('\n');
  console.log(`  → Processed ${processed} filings (${errors} skipped)`);
  console.log(`  → Found ${allPurchases.length} purchase transactions total`);

  const significant = allPurchases
    .filter(p => p.totalValue >= MIN_PURCHASE_VALUE)
    .sort((a, b) => b.totalValue - a.totalValue);

  console.log(`  → ${significant.length} purchase(s) ≥ ${fmt$(MIN_PURCHASE_VALUE)}`);

  await sendToSlack(significant);
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
