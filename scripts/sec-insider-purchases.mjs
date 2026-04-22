#!/usr/bin/env node
/**
 * SEC EDGAR Insider Purchase Scanner
 *
 * Fetches Form 4 filings for the last 24 hours, parses each XML, and
 * returns open-market purchases (transaction code "P") above $100 K,
 * ranked by total dollar value.
 *
 * Usage:
 *   node scripts/sec-insider-purchases.mjs          # live EDGAR data
 *   node scripts/sec-insider-purchases.mjs --demo   # realistic sample data
 *
 * EDGAR fair-use policy: User-Agent header required, max 10 req/s.
 * Docs: https://www.sec.gov/developer
 */

const DEMO_MODE = process.argv.includes('--demo');

const EDGAR_SEARCH   = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

const BASE_HEADERS = {
  'User-Agent': 'TradingJournalPro research@trading-journal-pro.com',
  'Accept-Encoding': 'gzip, deflate',
};

// ── Rate limiter (EDGAR: max 10 req/s) ─────────────────────────────────────
let _lastReq = 0;
async function _fetch(url, extraHeaders = {}) {
  const gap = 110 - (Date.now() - _lastReq);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _lastReq = Date.now();
  const res = await fetch(url, { headers: { ...BASE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res;
}
const fetchJSON = url => _fetch(url, { Accept: 'application/json' }).then(r => r.json());
const fetchText = url => _fetch(url).then(r => r.text());

// ── Minimal XML helpers (no external deps) ─────────────────────────────────
function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  const inner = m[1];
  const v = inner.match(/<value>\s*([\s\S]*?)\s*<\/value>/i);
  return (v ? v[1] : inner.replace(/<[^>]*>/g, '')).trim();
}

function xmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ── Form 4 XML parser ───────────────────────────────────────────────────────
function parseForm4(xml) {
  const issuerName   = xmlValue(xml, 'issuerName');
  const ticker       = xmlValue(xml, 'issuerTradingSymbol').toUpperCase();
  const reporterName = xmlValue(xml, 'rptOwnerName');
  const isDirector   = xmlValue(xml, 'isDirector') === '1';
  const isOfficer    = xmlValue(xml, 'isOfficer') === '1';
  const officerTitle = xmlValue(xml, 'officerTitle');

  const role = isOfficer && officerTitle
    ? officerTitle
    : isDirector ? 'Director'
    : isOfficer  ? 'Officer'
    : 'Insider';

  const purchases = [];
  for (const block of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    if (xmlValue(block, 'transactionCode')                !== 'P') continue;
    if (xmlValue(block, 'transactionAcquiredDisposedCode') !== 'A') continue;

    const shares = parseFloat(xmlValue(block, 'transactionShares')        || '0');
    const price  = parseFloat(xmlValue(block, 'transactionPricePerShare') || '0');
    if (shares <= 0 || price <= 0) continue;

    purchases.push({
      date:     xmlValue(block, 'transactionDate'),
      shares,
      price,
      value:    shares * price,
      security: xmlValue(block, 'securityTitle'),
    });
  }

  return { issuerName, ticker, reporterName, role, purchases };
}

// ── Accession number helpers ────────────────────────────────────────────────
// Format: "0001234567-26-000001" — first segment is the filer CIK (zero-padded).
const accCik    = accNo => String(parseInt(accNo.split('-')[0], 10));
const accNoDash = accNo => accNo.replace(/-/g, '');

async function findXmlUrl(cik, accNo) {
  const nd = accNoDash(accNo);
  try {
    const idx   = await fetchJSON(`${EDGAR_ARCHIVES}/${cik}/${nd}/${accNo}-index.json`);
    const items = idx?.directory?.item ?? [];
    const file  = items.find(i => i.type === '4' && i.name?.endsWith('.xml'))
               ?? items.find(i => i.name?.endsWith('.xml'));
    if (file) return `${EDGAR_ARCHIVES}/${cik}/${nd}/${file.name}`;
  } catch { /* fall through */ }
  return `${EDGAR_ARCHIVES}/${cik}/${nd}/form4.xml`;
}

// ── EDGAR EFTS search ───────────────────────────────────────────────────────
async function searchFilings(startDate, endDate, from = 0) {
  const url = `${EDGAR_SEARCH}?q=%22%22&forms=4&dateRange=custom`
    + `&startdt=${startDate}&enddt=${endDate}&from=${from}`;
  try {
    const data = await fetchJSON(url);
    return { hits: data.hits?.hits ?? [], total: data.hits?.total?.value ?? 0 };
  } catch (err) {
    process.stderr.write(`Search error (from=${from}): ${err.message}\n`);
    return { hits: [], total: 0 };
  }
}

// ── Demo data ───────────────────────────────────────────────────────────────
function buildDemoData(startDate, endDate) {
  return [
    {
      issuerName: 'Meta Platforms Inc.',
      ticker: 'META',
      reporterName: 'ZUCKERBERG MARK E',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 15000, price: 512.40, value: 7686000, security: 'Class A Common Stock' }],
      totalValue: 7686000,
      totalShares: 15000,
      avgPrice: 512.40,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'JPMorgan Chase & Co.',
      ticker: 'JPM',
      reporterName: 'DIMON JAMES',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 20000, price: 198.75, value: 3975000, security: 'Common Stock' }],
      totalValue: 3975000,
      totalShares: 20000,
      avgPrice: 198.75,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Nvidia Corporation',
      ticker: 'NVDA',
      reporterName: 'HUANG JEN-HSUN',
      role: 'President & Chief Executive Officer',
      purchases: [{ date: startDate, shares: 8500, price: 432.10, value: 3672850, security: 'Common Stock' }],
      totalValue: 3672850,
      totalShares: 8500,
      avgPrice: 432.10,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Berkshire Hathaway Inc.',
      ticker: 'BRK.B',
      reporterName: 'MUNGER CHARLES T',
      role: 'Director',
      purchases: [{ date: startDate, shares: 5000, price: 378.20, value: 1891000, security: 'Class B Common Stock' }],
      totalValue: 1891000,
      totalShares: 5000,
      avgPrice: 378.20,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Apple Inc.',
      ticker: 'AAPL',
      reporterName: 'LEVINSON ARTHUR D',
      role: 'Director',
      purchases: [{ date: startDate, shares: 10000, price: 172.35, value: 1723500, security: 'Common Stock' }],
      totalValue: 1723500,
      totalShares: 10000,
      avgPrice: 172.35,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Amazon.com Inc.',
      ticker: 'AMZN',
      reporterName: 'JASSY ANDREW R',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 9000, price: 183.60, value: 1652400, security: 'Common Stock' }],
      totalValue: 1652400,
      totalShares: 9000,
      avgPrice: 183.60,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Alphabet Inc.',
      ticker: 'GOOGL',
      reporterName: 'PICHAI SUNDAR',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 7500, price: 163.20, value: 1224000, security: 'Class A Common Stock' }],
      totalValue: 1224000,
      totalShares: 7500,
      avgPrice: 163.20,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Microsoft Corporation',
      ticker: 'MSFT',
      reporterName: 'NADELLA SATYA',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 2500, price: 418.90, value: 1047250, security: 'Common Stock' }],
      totalValue: 1047250,
      totalShares: 2500,
      avgPrice: 418.90,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Tesla Inc.',
      ticker: 'TSLA',
      reporterName: 'TANEJA VAIBHAV',
      role: 'Chief Financial Officer',
      purchases: [{ date: startDate, shares: 3000, price: 252.80, value: 758400, security: 'Common Stock' }],
      totalValue: 758400,
      totalShares: 3000,
      avgPrice: 252.80,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Visa Inc.',
      ticker: 'V',
      reporterName: 'SCHULMAN DAN',
      role: 'Director',
      purchases: [{ date: startDate, shares: 2000, price: 278.45, value: 556900, security: 'Class A Common Stock' }],
      totalValue: 556900,
      totalShares: 2000,
      avgPrice: 278.45,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Exxon Mobil Corporation',
      ticker: 'XOM',
      reporterName: 'WOODS DARREN W',
      role: 'Chairman & Chief Executive Officer',
      purchases: [{ date: startDate, shares: 4500, price: 112.30, value: 505350, security: 'Common Stock' }],
      totalValue: 505350,
      totalShares: 4500,
      avgPrice: 112.30,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Johnson & Johnson',
      ticker: 'JNJ',
      reporterName: 'DUATO JOAQUIN',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 2800, price: 153.70, value: 430360, security: 'Common Stock' }],
      totalValue: 430360,
      totalShares: 2800,
      avgPrice: 153.70,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Netflix Inc.',
      ticker: 'NFLX',
      reporterName: 'HASTINGS REED',
      role: 'Executive Chairman',
      purchases: [{ date: startDate, shares: 600, price: 607.50, value: 364500, security: 'Common Stock' }],
      totalValue: 364500,
      totalShares: 600,
      avgPrice: 607.50,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Salesforce Inc.',
      ticker: 'CRM',
      reporterName: 'BENIOFF MARC',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 1200, price: 275.30, value: 330360, security: 'Common Stock' }],
      totalValue: 330360,
      totalShares: 1200,
      avgPrice: 275.30,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Pfizer Inc.',
      ticker: 'PFE',
      reporterName: 'BOURLA ALBERT',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 8000, price: 28.15, value: 225200, security: 'Common Stock' }],
      totalValue: 225200,
      totalShares: 8000,
      avgPrice: 28.15,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Goldman Sachs Group Inc.',
      ticker: 'GS',
      reporterName: 'SOLOMON DAVID M',
      role: 'Chairman & Chief Executive Officer',
      purchases: [{ date: startDate, shares: 450, price: 482.20, value: 216990, security: 'Common Stock' }],
      totalValue: 216990,
      totalShares: 450,
      avgPrice: 482.20,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Chevron Corporation',
      ticker: 'CVX',
      reporterName: 'WIRTH MICHAEL K',
      role: 'Chairman & Chief Executive Officer',
      purchases: [{ date: startDate, shares: 1500, price: 138.60, value: 207900, security: 'Common Stock' }],
      totalValue: 207900,
      totalShares: 1500,
      avgPrice: 138.60,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Home Depot Inc.',
      ticker: 'HD',
      reporterName: 'CAREY WAYNE M',
      role: 'Director',
      purchases: [{ date: startDate, shares: 600, price: 326.40, value: 195840, security: 'Common Stock' }],
      totalValue: 195840,
      totalShares: 600,
      avgPrice: 326.40,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Walt Disney Company',
      ticker: 'DIS',
      reporterName: 'IGER ROBERT A',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 1800, price: 97.20, value: 174960, security: 'Common Stock' }],
      totalValue: 174960,
      totalShares: 1800,
      avgPrice: 97.20,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Costco Wholesale Corporation',
      ticker: 'COST',
      reporterName: 'JELINEK W CRAIG',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 200, price: 818.75, value: 163750, security: 'Common Stock' }],
      totalValue: 163750,
      totalShares: 200,
      avgPrice: 818.75,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Mastercard Incorporated',
      ticker: 'MA',
      reporterName: 'MIEBACH MICHAEL',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 350, price: 456.80, value: 159880, security: 'Class A Common Stock' }],
      totalValue: 159880,
      totalShares: 350,
      avgPrice: 456.80,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'UnitedHealth Group Inc.',
      ticker: 'UNH',
      reporterName: 'WITTY ANDREW',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 300, price: 482.50, value: 144750, security: 'Common Stock' }],
      totalValue: 144750,
      totalShares: 300,
      avgPrice: 482.50,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Palo Alto Networks Inc.',
      ticker: 'PANW',
      reporterName: 'ARORA NIKESH',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 500, price: 262.30, value: 131150, security: 'Common Stock' }],
      totalValue: 131150,
      totalShares: 500,
      avgPrice: 262.30,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Procter & Gamble Company',
      ticker: 'PG',
      reporterName: 'MOELLER JON R',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 800, price: 162.90, value: 130320, security: 'Common Stock' }],
      totalValue: 130320,
      totalShares: 800,
      avgPrice: 162.90,
      transactionDate: startDate,
      filingDate: endDate,
    },
    {
      issuerName: 'Airbnb Inc.',
      ticker: 'ABNB',
      reporterName: 'CHESKY BRIAN',
      role: 'Chief Executive Officer',
      purchases: [{ date: startDate, shares: 900, price: 126.40, value: 113760, security: 'Class A Common Stock' }],
      totalValue: 113760,
      totalShares: 900,
      avgPrice: 126.40,
      transactionDate: startDate,
      filingDate: endDate,
    },
  ];
}

// ── Live EDGAR scan ─────────────────────────────────────────────────────────
async function liveEdgarScan(startDate, endDate) {
  const qualified = [];
  let from  = 0;
  let total = Infinity;
  const MAX_FILINGS = 300;

  while (from < Math.min(total, MAX_FILINGS)) {
    const { hits, total: t } = await searchFilings(startDate, endDate, from);
    if (!hits.length) break;
    total = t;

    process.stderr.write(
      `  → batch ${from + 1}–${from + hits.length} of ${Math.min(total, MAX_FILINGS)}\n`
    );

    for (const hit of hits) {
      const accNo = hit._source?.accession_no;
      if (!accNo) continue;
      const cik = accCik(accNo);
      try {
        const xmlUrl = await findXmlUrl(cik, accNo);
        const xml = await fetchText(xmlUrl);
        const { issuerName, ticker, reporterName, role, purchases } = parseForm4(xml);

        const totalValue  = purchases.reduce((s, p) => s + p.value,  0);
        const totalShares = purchases.reduce((s, p) => s + p.shares, 0);
        if (totalValue < 100_000 || !purchases.length) continue;

        qualified.push({
          issuerName,
          ticker:          ticker || 'N/A',
          reporterName,
          role,
          purchases,
          totalValue,
          totalShares,
          avgPrice:        totalValue / totalShares,
          transactionDate: purchases[0].date,
          filingDate:      hit._source?.file_date ?? endDate,
        });
      } catch { /* skip inaccessible/malformed filings */ }
    }
    from += hits.length;
  }

  return qualified;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const now   = new Date();
  const start = new Date(now - 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate   = now.toISOString().slice(0, 10);

  if (DEMO_MODE) {
    process.stderr.write(`\n🧪 DEMO MODE — using sample data for ${startDate} → ${endDate}\n`);
  } else {
    process.stderr.write(`\n📡 Scanning EDGAR Form 4 filings: ${startDate} → ${endDate}\n`);
  }

  const purchases = DEMO_MODE
    ? buildDemoData(startDate, endDate)
    : await liveEdgarScan(startDate, endDate);

  purchases.sort((a, b) => b.totalValue - a.totalValue);

  process.stderr.write(`\n✅ ${purchases.length} insider purchases > $100K found.\n\n`);
  console.log(JSON.stringify({ startDate, endDate, purchases }, null, 2));
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
