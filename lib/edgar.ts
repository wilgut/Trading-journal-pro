/**
 * SEC EDGAR Form 4 client — fetches and parses insider purchase filings.
 *
 * Transaction code "P" = open-market purchase (excludes grants, awards, exercises).
 * All public API endpoints; no auth required.  Rate limit: 10 req/s (we stay well under).
 */

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const USER_AGENT =
  process.env.SEC_USER_AGENT ?? 'TradingJournalPro admin@tradingjournal.pro';

export interface InsiderBuy {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  transactionDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  filingUrl: string;
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

function xmlVal(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>[\\s\\S]*?<value>([\\s\\S]*?)<\\/value>`, 'i'));
  if (m) return m[1].trim();
  const m2 = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m2 ? m2[1].trim() : '';
}

function insiderTitle(xml: string): string {
  const title = xmlVal(xml, 'officerTitle');
  if (title) return title;
  if (xmlVal(xml, 'isDirector') === '1') return 'Director';
  if (xmlVal(xml, 'isOfficer') === '1') return 'Officer';
  if (xmlVal(xml, 'isTenPercentOwner') === '1') return '10% Owner';
  return 'Insider';
}

function parseForm4(xml: string, filingUrl: string): InsiderBuy[] {
  const buys: InsiderBuy[] = [];

  const companyName = xmlVal(xml, 'issuerName');
  const ticker = xmlVal(xml, 'issuerTradingSymbol');
  const insiderName = xmlVal(xml, 'rptOwnerName');
  const title = insiderTitle(xml);

  const txRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m: RegExpExecArray | null;

  while ((m = txRe.exec(xml)) !== null) {
    const tx = m[1];
    const code = xmlVal(tx, 'transactionCode');
    if (code !== 'P') continue; // only open-market purchases

    const adCode =
      xmlVal(tx, 'transactionAcquiredDisposedCode') ||
      (tx.match(/<transactionAcquiredDisposedCode>\s*<value>(\w)<\/value>/i)?.[1] ?? '');
    if (adCode && adCode !== 'A') continue; // must be Acquired

    const txDate = xmlVal(tx, 'transactionDate');
    const sharesRaw = xmlVal(tx, 'transactionShares');
    const priceRaw = xmlVal(tx, 'transactionPricePerShare');

    const shares = parseFloat(sharesRaw);
    const price = parseFloat(priceRaw);
    if (!shares || !price || isNaN(shares) || isNaN(price)) continue;

    buys.push({
      companyName: companyName || 'Unknown Company',
      ticker: ticker || 'N/A',
      insiderName: insiderName || 'Unknown',
      insiderTitle: title,
      transactionDate: txDate,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      filingUrl,
    });
  }

  return buys;
}

// ─── Network helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function secFetch(url: string): Promise<Response> {
  await sleep(150); // stay under the 10 req/s limit
  return fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/xml, */*',
    },
    cache: 'no-store',
  });
}

// ─── EDGAR search types ───────────────────────────────────────────────────────

interface SearchHit {
  _id: string;
  _source: {
    accession_no: string;
    entity_name: string;
    file_date: string;
  };
}

interface SearchResponse {
  hits: {
    total: { value: number };
    hits: SearchHit[];
  };
}

interface FilingIndex {
  primaryDocument?: string;
  documents?: Array<{ type: string; document: string; sequence?: string }>;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Returns insider purchases from the last `hoursBack` hours, value ≥ minValue,
 * ranked by total purchase value descending.
 */
export async function getInsiderBuys(
  minValue = 100_000,
  hoursBack = 24,
  maxFilings = 60,
): Promise<InsiderBuy[]> {
  const now = new Date();
  const since = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  // Fetch filing list — request two pages of 40 to cover busy days
  const pages = Math.ceil(maxFilings / 40);
  const searchHits: SearchHit[] = [];

  for (let page = 0; page < pages; page++) {
    const url =
      `${EDGAR_SEARCH}?forms=4` +
      `&dateRange=custom&startdt=${fmt(since)}&enddt=${fmt(now)}` +
      `&from=${page * 40}`;

    try {
      const res = await secFetch(url);
      if (!res.ok) break;
      const data: SearchResponse = await res.json();
      const hits = data?.hits?.hits ?? [];
      searchHits.push(...hits);
      if (hits.length < 40) break; // last page
    } catch {
      break;
    }
  }

  const allBuys: InsiderBuy[] = [];

  for (const hit of searchHits.slice(0, maxFilings)) {
    const accNo = hit._source.accession_no; // e.g. "0000918246-26-000001"
    // CIK is the first segment of the accession number (remove leading zeros)
    const cik = accNo.split('-')[0].replace(/^0+/, '') || accNo.split('-')[0];
    const accNoDash = accNo.replace(/-/g, '');

    // 1. Fetch the filing index to discover the primary XML filename
    const indexUrl = `${EDGAR_ARCHIVES}/${cik}/${accNoDash}/${accNo}-index.json`;
    let primaryDoc: string | undefined;

    try {
      const idxRes = await secFetch(indexUrl);
      if (!idxRes.ok) continue;
      const idx: FilingIndex = await idxRes.json();
      primaryDoc =
        idx.primaryDocument ??
        idx.documents?.find(d => d.type === '4' && d.document?.endsWith('.xml'))?.document;
    } catch {
      continue;
    }

    if (!primaryDoc) continue;

    // 2. Fetch and parse the XML
    const xmlUrl = `${EDGAR_ARCHIVES}/${cik}/${accNoDash}/${primaryDoc}`;
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${accNo}-index.htm`;

    try {
      const xmlRes = await secFetch(xmlUrl);
      if (!xmlRes.ok) continue;
      const xml = await xmlRes.text();
      allBuys.push(...parseForm4(xml, filingUrl));
    } catch {
      continue;
    }
  }

  return allBuys
    .filter(b => b.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue);
}
