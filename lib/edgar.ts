/**
 * SEC EDGAR Form 4 (insider ownership) scanner.
 *
 * Uses the EDGAR full-text search API to find recent Form 4 filings,
 * fetches each filing's XML from the EDGAR archives, and parses out
 * open-market stock purchases by directors and officers.
 *
 * SEC rate-limit guidance: ≤ 10 req/s per IP.
 * We keep concurrency at 5 and add a small inter-batch pause.
 */

const EFTS_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

// SEC requires a descriptive User-Agent: https://www.sec.gov/os/accessing-edgar-data
const SEC_HEADERS = {
  'User-Agent':
    process.env.SEC_USER_AGENT ??
    'TradingJournalPro admin@tradingjournal.example.com',
};

export interface InsiderPurchase {
  company: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  isDirector: boolean;
  isOfficer: boolean;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingDate: string;
  filingUrl: string;
}

interface EFTSHit {
  _source: {
    entity_name?: string;
    accession_no: string;
    file_date: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The first 10 digits of the accession number are the filer's CIK. */
function cikFromAccession(accessionNo: string): string {
  return String(parseInt(accessionNo.split('-')[0], 10));
}

function stripHyphens(s: string): string {
  return s.replace(/-/g, '');
}

/** Extract a field value from Form 4 XML.
 *  Handles both direct content and values wrapped in a nested <value> tag. */
function xmlVal(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  const content = m[1].trim();
  const nested = content.match(/<value[^>]*>([^<]*)<\/value>/i);
  if (nested) return nested[1].trim();
  return content.replace(/<[^>]+>/g, '').trim();
}

/** Extract all instances of a repeated XML block (e.g. <nonDerivativeTransaction>). */
function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

// ── EDGAR network layer ───────────────────────────────────────────────────────

async function fetchEFTS(
  startDate: string,
  endDate: string,
  from = 0,
): Promise<{ hits: EFTSHit[]; total: number }> {
  const url =
    `${EFTS_SEARCH}?q=&forms=4&dateRange=custom` +
    `&startdt=${startDate}&enddt=${endDate}&from=${from}`;

  const res = await fetch(url, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`EDGAR EFTS search failed: ${res.status}`);

  const data = await res.json();
  return {
    hits: (data.hits?.hits ?? []) as EFTSHit[],
    total: (data.hits?.total?.value ?? 0) as number,
  };
}

/** Resolve the URL of the primary Form 4 XML within a filing. */
async function resolveXMLUrl(
  cik: string,
  accessionNo: string,
): Promise<string | null> {
  const noDash = stripHyphens(accessionNo);
  const indexUrl = `${ARCHIVES}/${cik}/${noDash}/${noDash}-index.json`;

  const res = await fetch(indexUrl, { headers: SEC_HEADERS });
  if (!res.ok) return null;

  const index = await res.json();
  const docs: Array<{ type?: string; document?: string }> =
    index.documents ?? [];

  const hit =
    docs.find((d) => d.type === '4' && d.document?.endsWith('.xml')) ??
    docs.find((d) => d.document?.endsWith('.xml'));

  if (!hit?.document) return null;
  return `${ARCHIVES}/${cik}/${noDash}/${hit.document}`;
}

// ── Form 4 XML parser ─────────────────────────────────────────────────────────

function parseForm4(
  xml: string,
  fileDate: string,
  filingUrl: string,
): InsiderPurchase[] {
  const isDirector = xmlVal(xml, 'isDirector') === '1';
  const isOfficer = xmlVal(xml, 'isOfficer') === '1';

  // We only care about filings by directors or named officers
  if (!isDirector && !isOfficer) return [];

  const company = xmlVal(xml, 'issuerName') || 'Unknown';
  const ticker = xmlVal(xml, 'issuerTradingSymbol');
  const insiderName = xmlVal(xml, 'rptOwnerName') || 'Unknown';
  const officerTitle = xmlVal(xml, 'officerTitle');
  const insiderTitle =
    isOfficer && officerTitle ? officerTitle : 'Director';

  const purchases: InsiderPurchase[] = [];

  for (const txn of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const txnCode = xmlVal(txn, 'transactionCode');
    const adCode = xmlVal(txn, 'transactionAcquiredDisposedCode');

    // 'P' = open-market purchase.  Allow any non-disposal acquisition.
    const isPurchase = txnCode === 'P' || (adCode === 'A' && txnCode !== 'S');
    if (!isPurchase || adCode === 'D') continue;

    const shares = parseFloat(xmlVal(txn, 'transactionShares'));
    const price = parseFloat(xmlVal(txn, 'transactionPricePerShare'));

    if (!shares || !price || isNaN(shares) || isNaN(price) || price <= 0)
      continue;

    purchases.push({
      company,
      ticker,
      insiderName,
      insiderTitle,
      isDirector,
      isOfficer,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      transactionDate: xmlVal(txn, 'transactionDate') || fileDate,
      filingDate: fileDate,
      filingUrl,
    });
  }

  return purchases;
}

// ── Filing processor ──────────────────────────────────────────────────────────

async function processFiling(hit: EFTSHit): Promise<InsiderPurchase[]> {
  const { accession_no, file_date } = hit._source;
  if (!accession_no) return [];

  const cik = cikFromAccession(accession_no);

  try {
    const xmlUrl = await resolveXMLUrl(cik, accession_no);
    if (!xmlUrl) return [];

    const res = await fetch(xmlUrl, { headers: SEC_HEADERS });
    if (!res.ok) return [];

    return parseForm4(await res.text(), file_date, xmlUrl);
  } catch {
    return [];
  }
}

/** Run async tasks with a fixed concurrency limit. */
async function withConcurrency(
  hits: EFTSHit[],
  concurrency: number,
): Promise<InsiderPurchase[]> {
  const results: InsiderPurchase[] = [];

  for (let i = 0; i < hits.length; i += concurrency) {
    const batch = hits.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processFiling));
    results.push(...batchResults.flat());
    // Small pause between batches to stay within SEC rate-limit guidance
    if (i + concurrency < hits.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan EDGAR for Form 4 filings in the last 24 hours.
 * Returns purchases by directors/officers, filtered by minValue and ranked
 * largest-first.
 */
export async function getInsiderPurchases(
  minValue = 100_000,
  maxFilings = 100,
): Promise<InsiderPurchase[]> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = yesterday.toISOString().split('T')[0];
  const endDate = now.toISOString().split('T')[0];

  // First page
  const first = await fetchEFTS(startDate, endDate, 0);
  let hits = first.hits;
  const pageSize = hits.length || 10;

  // Paginate until we have enough filings or exhaust the result set
  let from = pageSize;
  while (hits.length < maxFilings && from < first.total) {
    const next = await fetchEFTS(startDate, endDate, from);
    if (next.hits.length === 0) break;
    hits = hits.concat(next.hits);
    from += next.hits.length;
  }

  hits = hits.slice(0, maxFilings);

  const purchases = await withConcurrency(hits, 5);

  return purchases
    .filter((p) => p.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue);
}
