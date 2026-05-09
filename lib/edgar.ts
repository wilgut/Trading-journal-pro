export interface InsiderTrade {
  insiderName: string;
  insiderTitle: string;
  companyName: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingDate: string;
  isDirector: boolean;
  isOfficer: boolean;
  accessionNo: string;
  edgarUrl: string;
}

interface EftsHit {
  _id: string;
  _source: {
    period_of_report?: string;
    entity_name?: string;
    file_date?: string;
    accession_no?: string;
  };
}

interface EftsResponse {
  hits: {
    total: { value: number };
    hits: EftsHit[];
  };
}

const EDGAR_BASE = 'https://www.sec.gov';
const EFTS_BASE = 'https://efts.sec.gov';

// SEC requires a descriptive User-Agent with contact info for all API calls
const EDGAR_HEADERS: Record<string, string> = {
  'User-Agent': 'Trading-Journal-Pro compliance@trading-journal-pro.example.com',
  'Accept-Encoding': 'gzip, deflate',
  Accept: 'application/json, text/html, */*',
};

const RATE_LIMIT_MS = 120;
const MAX_FILINGS_TO_CHECK = 200;
const BATCH_SIZE = 5;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handles both <tag>value</tag> and <tag><value>value</value></tag> patterns
function getTagValue(xml: string, tag: string): string {
  // Try value-wrapped pattern first: <tag ...><value>content</value>...</tag>
  const valueWrappedRe = new RegExp(
    `<${tag}[^>]*>[\\s\\S]*?<value>([^<]*)<\\/value>[\\s\\S]*?<\\/${tag}>`,
    'i'
  );
  const valueMatch = xml.match(valueWrappedRe);
  if (valueMatch) return valueMatch[1].trim();

  // Fall back to direct value pattern: <tag>content</tag>
  const directRe = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  const directMatch = xml.match(directRe);
  if (directMatch) return directMatch[1].trim();

  return '';
}

function parseForm4Xml(
  xml: string,
  accessionNo: string,
  filingDate: string
): InsiderTrade[] {
  const trades: InsiderTrade[] = [];

  const issuerName = getTagValue(xml, 'issuerName');
  const ticker = getTagValue(xml, 'issuerTradingSymbol').toUpperCase();
  const insiderName = getTagValue(xml, 'rptOwnerName');
  const isDirector = getTagValue(xml, 'isDirector') === '1';
  const isOfficer = getTagValue(xml, 'isOfficer') === '1';
  const officerTitle = getTagValue(xml, 'officerTitle');
  const insiderTitle =
    officerTitle || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider');

  // Accession number first segment is the filer CIK (may be a filing agent)
  const cikNum = parseInt(accessionNo.split('-')[0], 10).toString();
  const accessionNoDashes = accessionNo.replace(/-/g, '');
  const edgarUrl = `${EDGAR_BASE}/Archives/edgar/data/${cikNum}/${accessionNoDashes}/`;

  // Each nonDerivativeTransaction block is one stock transaction
  const blockRe =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(xml)) !== null) {
    const block = blockMatch[1];

    // P = open-market purchase; A = acquired (not disposed)
    if (getTagValue(block, 'transactionCode') !== 'P') continue;
    if (getTagValue(block, 'transactionAcquiredDisposedCode') !== 'A') continue;

    const shares = parseFloat(getTagValue(block, 'transactionShares'));
    const price = parseFloat(getTagValue(block, 'transactionPricePerShare'));
    if (!isFinite(shares) || !isFinite(price) || shares <= 0 || price <= 0) continue;

    trades.push({
      insiderName,
      insiderTitle,
      companyName: issuerName,
      ticker,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      transactionDate: getTagValue(block, 'transactionDate'),
      filingDate,
      isDirector,
      isOfficer,
      accessionNo,
      edgarUrl,
    });
  }

  return trades;
}

async function fetchXmlForFiling(
  cik: string,
  accessionNoDashes: string
): Promise<string | null> {
  const baseUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accessionNoDashes}`;

  try {
    // Fetch the filing index HTML to discover the primary XML document name
    const indexRes = await fetch(
      `${baseUrl}/${accessionNoDashes}-index.htm`,
      { headers: EDGAR_HEADERS }
    );
    if (!indexRes.ok) return null;

    const html = await indexRes.text();
    const xmlHref = html.match(/href="([^"]*\.xml)"/i)?.[1];
    if (!xmlHref) return null;

    const xmlUrl = xmlHref.startsWith('http')
      ? xmlHref
      : xmlHref.startsWith('/')
      ? `${EDGAR_BASE}${xmlHref}`
      : `${baseUrl}/${xmlHref}`;

    const xmlRes = await fetch(xmlUrl, { headers: EDGAR_HEADERS });
    if (!xmlRes.ok) return null;
    return xmlRes.text();
  } catch {
    return null;
  }
}

async function fetchEftsPage(
  startdt: string,
  enddt: string,
  from: number
): Promise<EftsResponse | null> {
  const url =
    `${EFTS_BASE}/LATEST/search-index` +
    `?q=&forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}`;
  try {
    const res = await fetch(url, { headers: EDGAR_HEADERS });
    if (!res.ok) return null;
    return res.json() as Promise<EftsResponse>;
  } catch {
    return null;
  }
}

function padDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchRecentInsiderPurchases(
  minValueUsd = 100_000
): Promise<InsiderTrade[]> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startdt = padDate(yesterday);
  const enddt = padDate(now);

  // Collect accession numbers from paginated EFTS search
  const accessions: { accessionNo: string; filingDate: string }[] = [];
  let from = 0;
  let total = Infinity;

  while (accessions.length < MAX_FILINGS_TO_CHECK && from < total) {
    const page = await fetchEftsPage(startdt, enddt, from);
    if (!page || page.hits.hits.length === 0) break;

    total = page.hits.total.value;
    for (const hit of page.hits.hits) {
      const accessionNo = hit._source.accession_no ?? hit._id;
      const filingDate = hit._source.file_date ?? enddt;
      accessions.push({ accessionNo, filingDate });
    }

    from += page.hits.hits.length;
    await sleep(RATE_LIMIT_MS);
  }

  // Fetch and parse Form 4 XML files in small concurrent batches
  const allTrades: InsiderTrade[] = [];

  for (let i = 0; i < accessions.length; i += BATCH_SIZE) {
    const batch = accessions.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ accessionNo, filingDate }) => {
        const cik = parseInt(accessionNo.split('-')[0], 10).toString();
        const accessionNoDashes = accessionNo.replace(/-/g, '');
        const xml = await fetchXmlForFiling(cik, accessionNoDashes);
        if (!xml) return [] as InsiderTrade[];
        return parseForm4Xml(xml, accessionNo, filingDate);
      })
    );
    for (const trades of batchResults) allTrades.push(...trades);
    await sleep(RATE_LIMIT_MS);
  }

  return allTrades
    .filter(t => t.totalValue >= minValueUsd && (t.isDirector || t.isOfficer))
    .sort((a, b) => b.totalValue - a.totalValue);
}
