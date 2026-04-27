#!/usr/bin/env npx tsx
/**
 * SEC EDGAR Insider Purchase Scanner
 *
 * Fetches Form 4 filings from SEC EDGAR for the last 24 hours,
 * parses each XML to extract open-market stock purchases (code "P"),
 * filters for executive/director buys >= $100 000,
 * and posts a ranked Slack summary.
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL   Incoming-webhook URL for posting (optional;
 *                       omit to print to stdout only)
 *
 * Usage:
 *   npx tsx scripts/sec-insider-buys.ts
 *   npx tsx scripts/sec-insider-buys.ts --limit 200   # cap filings scanned
 *   npx tsx scripts/sec-insider-buys.ts --days 1      # look-back window (default 1)
 *   npx tsx scripts/sec-insider-buys.ts --demo        # run with synthetic data
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_AGENT     = 'TradingJournalPro/1.0 (github.com/wilgut/trading-journal-pro)';
const MIN_VALUE      = 100_000;    // $100k purchase threshold
const DELAY_MS       = 150;        // pause between EDGAR requests (~6 req/s)
const DEFAULT_LIMIT  = 500;        // max Form 4 filings to process
const PAGE_SIZE      = 200;        // EFTS search page size

// ── Types ─────────────────────────────────────────────────────────────────────

interface EdgarHit {
  _id: string;
  _source: {
    entity_name?: string;
    file_date?: string;
    period_of_report?: string;
    [k: string]: unknown;
  };
}

export interface InsiderPurchase {
  rank: number;
  insiderName: string;
  title: string;
  isDirector: boolean;
  isOfficer: boolean;
  companyName: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  edgarUrl: string;
}

export interface ScanResult {
  generatedAt: string;
  dateRange: { startDate: string; endDate: string };
  totalFilingsScanned: number;
  minPurchaseValue: number;
  purchases: InsiderPurchase[];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isoDate(d: Date) {
  return d.toISOString().split('T')[0];
}

function fmt$$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

async function httpGet(url: string, accept = 'application/json'): Promise<Response> {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (res.ok) return res;
    if (res.status === 429) { await sleep(2_000 * (i + 1)); continue; }
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  throw new Error('Max retries exceeded');
}

// ── XML helpers ───────────────────────────────────────────────────────────────

/**
 * Extracts text from either:
 *   <tag>value</tag>
 *   <tag><value>value</value></tag>   (EDGAR typed field format)
 */
function xmlVal(xml: string, tag: string): string {
  const wrapped = xml.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]*)<\\/value>`, 'i'));
  if (wrapped) return wrapped[1].trim();
  const direct  = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return direct ? direct[1].trim() : '';
}

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ── EDGAR helpers ─────────────────────────────────────────────────────────────

async function searchForm4(startDate: string, endDate: string, from: number): Promise<{
  hits: { total: { value: number }; hits: EdgarHit[] };
}> {
  const qs = new URLSearchParams({
    q: '', forms: '4', dateRange: 'custom',
    startdt: startDate, enddt: endDate,
    from: String(from), size: String(PAGE_SIZE),
  });
  const res = await httpGet(`https://efts.sec.gov/LATEST/search-index?${qs}`);
  return res.json();
}

/** Derive filer CIK from the first 10 digits of the accession number. */
function cikFromAccession(accNo: string): string {
  return String(parseInt(accNo.replace(/-/g, '').slice(0, 10), 10));
}

function noDashes(accNo: string) { return accNo.replace(/-/g, ''); }

function filingIndexUrl(cik: string, accNo: string) {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${noDashes(accNo)}/${accNo}-index.htm`;
}

async function findXmlUrl(cik: string, accNo: string): Promise<string | null> {
  const html = await (await httpGet(filingIndexUrl(cik, accNo), 'text/html')).text();
  const m = html.match(/href="([^"]*?\.xml)"/i);
  if (!m) return null;
  const p = m[1];
  if (p.startsWith('http')) return p;
  if (p.startsWith('/'))    return `https://www.sec.gov${p}`;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${noDashes(accNo)}/${p}`;
}

// ── Form 4 parser ─────────────────────────────────────────────────────────────

function parseForm4(xml: string, cik: string, accNo: string): Omit<InsiderPurchase, 'rank'>[] {
  const companyName = xmlVal(xml, 'issuerName') || 'Unknown';
  const ticker      = xmlVal(xml, 'issuerTradingSymbol');
  const ownerName   = xmlVal(xml, 'rptOwnerName') || 'Unknown';
  const isDirector  = xmlVal(xml, 'isDirector') === '1';
  const isOfficer   = xmlVal(xml, 'isOfficer') === '1';
  const isTenPct    = xmlVal(xml, 'isTenPercentOwner') === '1';

  if (!isDirector && !isOfficer && !isTenPct) return [];

  const title    = xmlVal(xml, 'officerTitle');
  const edgarUrl = filingIndexUrl(cik, accNo);
  const out: Omit<InsiderPurchase, 'rank'>[] = [];

  for (const tx of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    if (xmlVal(tx, 'transactionCode') !== 'P') continue;
    if (xmlVal(tx, 'transactionAcquiredDisposedCode') !== 'A') continue;

    const shares = parseFloat(xmlVal(tx, 'transactionShares') || '0');
    const price  = parseFloat(xmlVal(tx, 'transactionPricePerShare') || '0');
    const date   = xmlVal(tx, 'transactionDate');

    if (!shares || !price) continue;

    out.push({
      insiderName: ownerName, title, isDirector, isOfficer,
      companyName, ticker, shares, pricePerShare: price,
      totalValue: shares * price, transactionDate: date, edgarUrl,
    });
  }
  return out;
}

// ── Demo data (used with --demo flag) ─────────────────────────────────────────

function demoData(): Omit<ScanResult, 'generatedAt'> {
  const today = isoDate(new Date());
  const yesterday = isoDate(new Date(Date.now() - 86_400_000));
  const raw: Omit<InsiderPurchase, 'rank'>[] = [
    { insiderName: 'Jensen Huang',        title: 'President & CEO', isOfficer: true,  isDirector: false, companyName: 'NVIDIA Corporation',           ticker: 'NVDA', shares: 45_000,  pricePerShare: 875.40, totalValue: 39_393_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=4' },
    { insiderName: 'Elon Musk',           title: 'CEO',             isOfficer: true,  isDirector: true,  companyName: 'Tesla, Inc.',                  ticker: 'TSLA', shares: 250_000, pricePerShare: 52.11,  totalValue: 13_027_500, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001318605&type=4' },
    { insiderName: 'Satya Nadella',       title: 'Chairman & CEO',  isOfficer: true,  isDirector: true,  companyName: 'Microsoft Corporation',        ticker: 'MSFT', shares: 28_000,  pricePerShare: 392.85, totalValue: 10_999_800, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019&type=4' },
    { insiderName: 'Lisa Su',             title: 'President & CEO', isOfficer: true,  isDirector: false, companyName: 'Advanced Micro Devices, Inc.', ticker: 'AMD',  shares: 60_000,  pricePerShare: 124.55, totalValue:  7_473_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000002488&type=4' },
    { insiderName: 'Warren Buffett',      title: 'Chairman & CEO',  isOfficer: true,  isDirector: true,  companyName: 'Berkshire Hathaway Inc.',      ticker: 'BRK.B',shares: 15_000,  pricePerShare: 452.20, totalValue:  6_783_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=4' },
    { insiderName: 'Andy Jassy',          title: 'President & CEO', isOfficer: true,  isDirector: false, companyName: 'Amazon.com, Inc.',             ticker: 'AMZN', shares: 30_000,  pricePerShare: 198.75, totalValue:  5_962_500, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001018724&type=4' },
    { insiderName: 'Ruth Porat',          title: 'President & CFO', isOfficer: true,  isDirector: false, companyName: 'Alphabet Inc.',               ticker: 'GOOGL',shares: 20_000,  pricePerShare: 172.40, totalValue:  3_448_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001652044&type=4' },
    { insiderName: 'Marc Benioff',        title: 'Chairman & CEO',  isOfficer: true,  isDirector: true,  companyName: 'Salesforce, Inc.',            ticker: 'CRM',  shares: 12_500,  pricePerShare: 258.30, totalValue:  3_228_750, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001108524&type=4' },
    { insiderName: 'Patricia Poppe',      title: 'CEO',             isOfficer: true,  isDirector: false, companyName: 'PG&E Corporation',            ticker: 'PCG',  shares: 150_000, pricePerShare: 18.42,  totalValue:  2_763_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001004440&type=4' },
    { insiderName: 'James Dimon',         title: 'Chairman & CEO',  isOfficer: true,  isDirector: true,  companyName: 'JPMorgan Chase & Co.',        ticker: 'JPM',  shares: 10_000,  pricePerShare: 235.60, totalValue:  2_356_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000019617&type=4' },
    { insiderName: 'Arvind Krishna',      title: 'Chairman & CEO',  isOfficer: true,  isDirector: true,  companyName: 'International Business Machines',ticker: 'IBM', shares: 12_000, pricePerShare: 181.25, totalValue:  2_175_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143&type=4' },
    { insiderName: 'Robert Ford',         title: 'CEO & Director',  isOfficer: true,  isDirector: true,  companyName: 'Abbott Laboratories',          ticker: 'ABT',  shares: 18_000,  pricePerShare: 117.80, totalValue:  2_120_400, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000001800&type=4' },
    { insiderName: 'Dario Amodei',        title: 'Co-Founder & CEO',isOfficer: true,  isDirector: false, companyName: 'Anthropic PBC',               ticker: '',     shares: 5_000,   pricePerShare: 320.00, totalValue:  1_600_000, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001861230&type=4' },
    { insiderName: 'Carol Tomé',          title: 'CEO',             isOfficer: true,  isDirector: false, companyName: 'United Parcel Service, Inc.',  ticker: 'UPS',  shares: 13_000,  pricePerShare: 105.45, totalValue:  1_370_850, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001090727&type=4' },
    { insiderName: 'John Donahoe',        title: 'Director',        isOfficer: false, isDirector: true,  companyName: 'NIKE, Inc.',                  ticker: 'NKE',  shares: 14_000,  pricePerShare: 92.30,  totalValue:  1_292_200, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320187&type=4' },
    { insiderName: 'Mary Barra',          title: 'Chair & CEO',     isOfficer: true,  isDirector: true,  companyName: 'General Motors Company',      ticker: 'GM',   shares: 25_000,  pricePerShare: 50.15,  totalValue:  1_253_750, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001467858&type=4' },
    { insiderName: 'Sundar Pichai',       title: 'CEO',             isOfficer: true,  isDirector: false, companyName: 'Alphabet Inc.',               ticker: 'GOOGL',shares: 5_500,   pricePerShare: 172.40, totalValue:    948_200, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001652044&type=4' },
    { insiderName: 'Tim Cook',            title: 'CEO',             isOfficer: true,  isDirector: false, companyName: 'Apple Inc.',                  ticker: 'AAPL', shares: 4_000,   pricePerShare: 209.80, totalValue:    839_200, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=4' },
    { insiderName: 'Douglas McMillon',    title: 'CEO & Director',  isOfficer: true,  isDirector: true,  companyName: 'Walmart Inc.',                ticker: 'WMT',  shares: 5_000,   pricePerShare: 165.50, totalValue:    827_500, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000104169&type=4' },
    { insiderName: 'Kathy Warden',        title: 'Chair & CEO',     isOfficer: true,  isDirector: true,  companyName: 'Northrop Grumman Corporation',ticker: 'NOC',  shares: 2_000,   pricePerShare: 490.25, totalValue:    980_500, transactionDate: today, edgarUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001133421&type=4' },
  ];
  const purchases = raw
    .filter(p => p.totalValue >= MIN_VALUE)
    .sort((a, b) => b.totalValue - a.totalValue)
    .map((p, i) => ({ ...p, rank: i + 1 }));
  return {
    dateRange: { startDate: yesterday, endDate: today },
    totalFilingsScanned: 487,
    minPurchaseValue: MIN_VALUE,
    purchases,
  };
}

// ── Slack formatter ───────────────────────────────────────────────────────────

function rankEmoji(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `*${rank}.*`;
}

function roleBadge(p: InsiderPurchase): string {
  if (p.isOfficer && p.isDirector) return 'Officer & Director';
  if (p.isOfficer) return 'Officer';
  if (p.isDirector) return 'Director';
  return '10%+ Owner';
}

export function buildSlackMessage(result: ScanResult, isDemo = false): string {
  const { dateRange, totalFilingsScanned, purchases } = result;
  const demoTag = isDemo ? '  _(demo data)_' : '';

  const header = [
    `🕵️ *SEC Insider Purchase Alert*${demoTag}`,
    `> Open-market buys by executives & directors  |  Threshold: *>${fmt$$(MIN_VALUE)}*`,
    `> Period: *${dateRange.startDate}* → *${dateRange.endDate}*  |  Form 4 filings scanned: *${totalFilingsScanned.toLocaleString()}*`,
    '',
    purchases.length === 0
      ? '_No qualifying purchases found in this window._'
      : `*${purchases.length} significant purchase${purchases.length === 1 ? '' : 's'} found — ranked by value:*`,
    '',
  ].join('\n');

  if (purchases.length === 0) return header;

  const lines = purchases.map(p => {
    const ticker  = p.ticker ? ` (${p.ticker})` : '';
    const title   = p.title  ? ` — _${p.title}_` : '';
    const role    = roleBadge(p);
    const link    = `<${p.edgarUrl}|SEC Filing>`;
    return [
      `${rankEmoji(p.rank)}  *${fmt$$(p.totalValue)}*  |  *${p.companyName}*${ticker}`,
      `      ${p.insiderName}${title}  [${role}]`,
      `      ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)}  |  ${link}`,
    ].join('\n');
  });

  const topBuyers = purchases.slice(0, 3).map(p =>
    `• *${p.ticker || p.companyName}* ${fmt$$(p.totalValue)} by ${p.insiderName}`
  ).join('\n');

  const footer = [
    '',
    '─────────────────────────────────────',
    '*Top 3 by value:*',
    topBuyers,
    `\n_Generated ${result.generatedAt}  |  Data: SEC EDGAR Form 4_`,
  ].join('\n');

  return header + lines.join('\n\n') + footer;
}

// ── Slack webhook poster ──────────────────────────────────────────────────────

async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook error: ${res.status} ${await res.text()}`);
}

// ── Live scan ─────────────────────────────────────────────────────────────────

async function liveScan(startDate: string, endDate: string, limit: number): Promise<ScanResult> {
  const allHits: EdgarHit[] = [];

  while (allHits.length < limit) {
    const data = await searchForm4(startDate, endDate, allHits.length);
    const hits  = data?.hits?.hits ?? [];
    if (!hits.length) break;
    allHits.push(...hits);
    const total = data.hits?.total?.value ?? 0;
    process.stderr.write(`  Indexed ${allHits.length} / ${Math.min(total, limit)} filings\n`);
    if (allHits.length >= total || hits.length < PAGE_SIZE) break;
    await sleep(DELAY_MS);
  }

  process.stderr.write(`\nParsing ${Math.min(allHits.length, limit)} filings...\n`);
  const allPurchases: Omit<InsiderPurchase, 'rank'>[] = [];
  let processed = 0;
  let errors    = 0;

  for (const hit of allHits.slice(0, limit)) {
    const accNo = hit._id;
    if (!accNo) { processed++; continue; }
    const cik = cikFromAccession(accNo);
    try {
      await sleep(DELAY_MS);
      const xmlUrl = await findXmlUrl(cik, accNo);
      if (!xmlUrl) { processed++; continue; }
      await sleep(DELAY_MS);
      const xml = await (await httpGet(xmlUrl, 'application/xml,text/xml')).text();
      allPurchases.push(...parseForm4(xml, cik, accNo));
    } catch { errors++; }
    processed++;
    if (processed % 50 === 0)
      process.stderr.write(`  ${processed}/${allHits.length} parsed — ${allPurchases.length} buys found\n`);
  }

  process.stderr.write(`Done. ${processed} parsed, ${errors} errors.\n`);

  const purchases = allPurchases
    .filter(p => p.totalValue >= MIN_VALUE)
    .sort((a, b) => b.totalValue - a.totalValue)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  return {
    generatedAt: new Date().toISOString(),
    dateRange: { startDate, endDate },
    totalFilingsScanned: processed,
    minPurchaseValue: MIN_VALUE,
    purchases,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const flag    = (name: string) => args.includes(name);
  const argVal  = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    return i !== -1 ? parseInt(args[i + 1], 10) : fallback;
  };

  const isDemo = flag('--demo');
  const limit  = argVal('--limit', DEFAULT_LIMIT);
  const days   = argVal('--days', 1);

  const now        = new Date();
  const startDate  = isoDate(new Date(now.getTime() - days * 86_400_000));
  const endDate    = isoDate(now);

  process.stderr.write(`\nSEC EDGAR Insider Purchase Scanner\n`);
  process.stderr.write(`Date range : ${startDate} → ${endDate}\n`);
  process.stderr.write(`Min value  : $${MIN_VALUE.toLocaleString()}\n`);
  process.stderr.write(isDemo ? `Mode       : DEMO (synthetic data)\n\n` : `Max filings: ${limit}\n\n`);

  let result: ScanResult;

  if (isDemo) {
    const d = demoData();
    result = { generatedAt: now.toISOString(), ...d };
  } else {
    result = await liveScan(startDate, endDate, limit);
  }

  // Print JSON to stdout
  console.log(JSON.stringify(result, null, 2));

  // Post to Slack if webhook is configured
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    process.stderr.write('\nPosting to Slack...\n');
    const msg = buildSlackMessage(result, isDemo);
    await postToSlack(webhookUrl, msg);
    process.stderr.write('Posted.\n');
  } else {
    process.stderr.write('\n(Set SLACK_WEBHOOK_URL env var to auto-post to Slack)\n');
  }

  process.stderr.write(`\n✓ ${result.purchases.length} significant purchases (>= $${MIN_VALUE.toLocaleString()})\n`);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
