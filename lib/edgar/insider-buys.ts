/**
 * SEC EDGAR Form 4 insider-buying monitor.
 *
 * Fetches Form 4 filings filed in the last 24 h, parses each XML for
 * open-market purchases (transaction code "P"), filters out noise
 * (< $100 k by default), and returns results ranked by total dollar value.
 *
 * SEC rate-limit guidance: ≤ 10 requests / second.
 * We stay well under that with batched concurrency + inter-batch delays.
 */

const EDGAR_BASE = 'https://www.sec.gov';
const EFTS_BASE  = 'https://efts.sec.gov';

// SEC requires a descriptive User-Agent – override via env if needed.
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ??
  'TradingJournalPro contact@tradingjournalpro.com';

const FETCH_CONCURRENCY  = 5;   // parallel XML fetches per batch
const BATCH_DELAY_MS     = 600; // pause between batches  (~8 req/s)
const MAX_FILINGS        = 500; // safety cap per invocation
const FETCH_TIMEOUT_MS   = 15_000;

// ─── Public types ──────────────────────────────────────────────────────────

export interface InsiderBuy {
  companyName:     string;
  ticker:          string;
  insiderName:     string;
  insiderTitle:    string;
  relationship:    'Director' | 'Officer' | 'Director & Officer' | 'Other';
  shares:          number;
  pricePerShare:   number;
  totalValue:      number;
  transactionDate: string;
  filingDate:      string;
  filingUrl:       string;
  accessionNo:     string;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

interface FilingHit {
  _id: string;
  _source: {
    file_date:        string;
    entity_name:      string;
    period_of_report: string;
    accession_no:     string;
  };
}

interface EdgarSearchResponse {
  hits: {
    total: { value: number };
    hits:  FilingHit[];
  };
}

interface FilingIndexResponse {
  directory?: {
    item?: Array<{ name: string; type: string }>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function edgarGet(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** Extract the inner text of an XML tag that uses either
 *  `<tag>text</tag>` or `<tag><value>text</value></tag>`. */
function xmlVal(block: string, tag: string): string {
  const nested = block.match(
    new RegExp(`<${tag}[^>]*>\\s*<value>([^<]*)<\\/value>`, 'i'),
  );
  if (nested) return nested[1].trim();

  const direct = block.match(
    new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
  );
  return direct ? direct[1].trim() : '';
}

/** Return all occurrences of a top-level tag block. */
function xmlAll(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) results.push(m[0]);
  return results;
}

/** Build the EDGAR filing directory URL from an accession number.
 *  Accession format: XXXXXXXXXX-YY-ZZZZZZ  (filer CIK - year - seq) */
function filingDirUrl(accessionNo: string): { cik: string; noDash: string; base: string } | null {
  const parts = accessionNo.match(/^(\d{10})-(\d{2})-(\d{6})$/);
  if (!parts) return null;

  const cik    = String(parseInt(parts[1], 10)); // strip leading zeros
  const noDash = accessionNo.replace(/-/g, '');
  return { cik, noDash, base: `${EDGAR_BASE}/Archives/edgar/data/${cik}/${noDash}` };
}

async function fetchFilingXml(accessionNo: string): Promise<string | null> {
  const dir = filingDirUrl(accessionNo);
  if (!dir) return null;

  // Most Form 4 filings name the primary doc <accession-no-nodash>.xml
  const primary = `${dir.base}/${dir.noDash}.xml`;
  try {
    const res = await edgarGet(primary);
    if (res.ok) return res.text();
  } catch { /* fall through */ }

  // Fall back: read the filing index and locate the first .xml document
  try {
    const idxRes = await edgarGet(`${dir.base}/index.json`);
    if (!idxRes.ok) return null;

    const idx = (await idxRes.json()) as FilingIndexResponse;
    const xmlFile = idx.directory?.item?.find(
      f => f.type === '4' || (f.name.endsWith('.xml') && !f.name.includes('index')),
    );
    if (!xmlFile) return null;

    const fileRes = await edgarGet(`${dir.base}/${xmlFile.name}`);
    return fileRes.ok ? fileRes.text() : null;
  } catch {
    return null;
  }
}

function parseForm4(xml: string, filingDate: string, accessionNo: string): InsiderBuy[] {
  const issuerBlock = xml.match(/<issuer[\s\S]*?<\/issuer>/i)?.[0] ?? '';
  const companyName = xmlVal(issuerBlock, 'issuerName');
  const ticker      = xmlVal(issuerBlock, 'issuerTradingSymbol').toUpperCase();

  const ownerBlock  = xml.match(/<reportingOwner[\s\S]*?<\/reportingOwner>/i)?.[0] ?? '';
  const insiderName = xmlVal(ownerBlock, 'rptOwnerName');
  const officerTitle = xmlVal(ownerBlock, 'officerTitle');
  const isDirector  = xmlVal(ownerBlock, 'isDirector') === '1';
  const isOfficer   = xmlVal(ownerBlock, 'isOfficer') === '1';

  const relationship: InsiderBuy['relationship'] =
    isDirector && isOfficer ? 'Director & Officer'
    : isDirector            ? 'Director'
    : isOfficer             ? 'Officer'
    :                         'Other';

  const dir = filingDirUrl(accessionNo);
  const filingUrl = dir
    ? `${EDGAR_BASE}/Archives/edgar/data/${dir.cik}/${dir.noDash}/${dir.noDash}-index.htm`
    : `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&type=4`;

  const buys: InsiderBuy[] = [];

  for (const txn of xmlAll(xml, 'nonDerivativeTransaction')) {
    const txnCode        = xmlVal(txn, 'transactionCode');
    const acquiredOrDisp = xmlVal(txn, 'transactionAcquiredDisposedCode');

    // Only open-market purchases (code P) or acquisitions not coded as sales
    if (txnCode === 'S' || acquiredOrDisp === 'D') continue;
    if (txnCode !== 'P') continue;

    const shares = parseFloat(xmlVal(txn, 'transactionShares'));
    const price  = parseFloat(xmlVal(txn, 'transactionPricePerShare'));
    const date   = xmlVal(txn, 'transactionDate');

    if (!shares || !price || price <= 0 || isNaN(shares) || isNaN(price)) continue;

    buys.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle: officerTitle || (isDirector ? 'Director' : 'Insider'),
      relationship,
      shares,
      pricePerShare: price,
      totalValue:    shares * price,
      transactionDate: date || filingDate,
      filingDate,
      filingUrl,
      accessionNo,
    });
  }

  return buys;
}

async function fetchRecentForm4s(startDate: string, endDate: string): Promise<FilingHit[]> {
  const all: FilingHit[] = [];
  let from = 0;
  let total = Infinity;

  while (all.length < Math.min(total, MAX_FILINGS)) {
    const url =
      `${EFTS_BASE}/LATEST/search-index` +
      `?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
      `&hits.hits.total.value=true&from=${from}` +
      `&hits.hits._source=file_date,entity_name,period_of_report,accession_no`;

    try {
      const res = await edgarGet(url);
      if (!res.ok) break;

      const data = (await res.json()) as EdgarSearchResponse;
      const hits = data.hits?.hits ?? [];
      total = data.hits?.total?.value ?? 0;

      if (hits.length === 0) break;
      all.push(...hits);
      from += hits.length;

      await sleep(BATCH_DELAY_MS);
    } catch {
      break;
    }
  }

  return all;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns insider open-market purchases filed in the last 24 hours that
 * exceed `minValueUsd`, ranked by total purchase value (largest first).
 */
export async function getInsiderBuys(minValueUsd = 100_000): Promise<InsiderBuy[]> {
  const now       = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = yesterday.toISOString().slice(0, 10);
  const endDate   = now.toISOString().slice(0, 10);

  const filings = await fetchRecentForm4s(startDate, endDate);

  // Fetch & parse XMLs in rate-limited batches
  const allBuys: InsiderBuy[] = [];
  for (let i = 0; i < filings.length; i += FETCH_CONCURRENCY) {
    const batch = filings.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async f => {
        const xml = await fetchFilingXml(f._source.accession_no);
        return xml ? parseForm4(xml, f._source.file_date, f._source.accession_no) : [];
      }),
    );
    allBuys.push(...results.flat());
    if (i + FETCH_CONCURRENCY < filings.length) await sleep(BATCH_DELAY_MS);
  }

  // Filter, deduplicate, sort
  const seen = new Set<string>();
  return allBuys
    .filter(b => b.totalValue >= minValueUsd && b.companyName && b.ticker)
    .sort((a, b) => b.totalValue - a.totalValue)
    .filter(b => {
      const key = `${b.accessionNo}|${b.insiderName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
