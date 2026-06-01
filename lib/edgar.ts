import { XMLParser } from 'fast-xml-parser';

const EDGAR_BASE = 'https://www.sec.gov';
const EFTS_BASE = 'https://efts.sec.gov';

// Required by SEC EDGAR — must identify the app and provide contact info
const USER_AGENT = 'TradingJournalPro contact@tradingjournalpro.com';

export interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingDate: string;
  accessionNumber: string;
  filingUrl: string;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extracts CIK from accession number (first 10 digits, no leading zeros)
function cikFromAccession(accessionNo: string): string {
  return String(parseInt(accessionNo.split('-')[0], 10));
}

// Fetches Form 4 filing accession numbers from EDGAR EFTS for a given date range
async function fetchForm4FilingIds(startdt: string, enddt: string): Promise<string[]> {
  const url =
    `${EFTS_BASE}/LATEST/search-index?forms=4&dateRange=custom` +
    `&startdt=${startdt}&enddt=${enddt}&from=0&size=100`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`EDGAR EFTS error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const hits: Array<{ _id: string }> = data?.hits?.hits ?? [];
  return hits.map(h => h._id);
}

// Fetches the filing index JSON to locate the Form 4 XML document name
async function resolveXmlUrl(accessionNo: string): Promise<string | null> {
  const filerCik = cikFromAccession(accessionNo);
  const accNoClean = accessionNo.replace(/-/g, '');
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${filerCik}/${accNoClean}/${accessionNo}-index.json`;

  const res = await fetch(indexUrl, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
  });
  if (!res.ok) return null;

  let indexData: { directory?: { item?: Array<{ name: string; type: string }> } };
  try {
    indexData = await res.json();
  } catch {
    return null;
  }

  const items: Array<{ name: string; type: string }> = indexData?.directory?.item ?? [];
  const xmlItem = items.find(i => i.type === '4' || (i.name?.endsWith('.xml') && !i.name.includes('primary_doc')));

  if (!xmlItem) return null;
  return `${EDGAR_BASE}/Archives/edgar/data/${filerCik}/${accNoClean}/${xmlItem.name}`;
}

// Parses a Form 4 XML document and returns qualifying purchase transactions
async function parsePurchases(
  xmlUrl: string,
  accessionNo: string,
  filingDate: string,
  minValue: number
): Promise<InsiderPurchase[]> {
  const res = await fetch(xmlUrl, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
  });
  if (!res.ok) return [];

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true });

  let doc: Record<string, unknown>;
  try {
    const root = parser.parse(xml);
    doc = root?.ownershipDocument ?? root?.['?xml']?.ownershipDocument ?? null;
    if (!doc) return [];
  } catch {
    return [];
  }

  const issuer = doc.issuer as Record<string, unknown>;
  const ownerRaw = doc.reportingOwner;
  const owner = Array.isArray(ownerRaw) ? ownerRaw[0] : ownerRaw as Record<string, unknown>;

  const companyName = String(issuer?.issuerName ?? 'Unknown');
  const ticker = String(issuer?.issuerTradingSymbol ?? '');
  const insiderName = String((owner?.reportingOwnerId as Record<string, unknown>)?.rptOwnerName ?? 'Unknown');

  const rel = (owner?.reportingOwnerRelationship ?? {}) as Record<string, unknown>;
  const insiderTitle =
    String(rel.officerTitle ?? '') ||
    (String(rel.isDirector) === '1' ? 'Director' : '') ||
    (String(rel.isTenPercentOwner) === '1' ? '10% Owner' : 'Insider');

  const purchases: InsiderPurchase[] = [];

  const rawTxns = (doc.nonDerivativeTable as Record<string, unknown>)?.nonDerivativeTransaction;
  const txns: unknown[] = rawTxns == null ? [] : Array.isArray(rawTxns) ? rawTxns : [rawTxns];

  for (const rawTxn of txns) {
    const txn = rawTxn as Record<string, unknown>;

    const code = (txn.transactionCoding as Record<string, unknown>)?.transactionCode;
    const amounts = txn.transactionAmounts as Record<string, unknown>;
    const acquired = (amounts?.transactionAcquiredDisposedCode as Record<string, unknown>)?.value;

    // P = open-market purchase; A = acquired
    if (code !== 'P' || acquired !== 'A') continue;

    const shares = parseFloat(String((amounts?.transactionShares as Record<string, unknown>)?.value ?? '0'));
    const price = parseFloat(String((amounts?.transactionPricePerShare as Record<string, unknown>)?.value ?? '0'));
    const totalValue = shares * price;

    if (!isFinite(totalValue) || totalValue < minValue) continue;

    const txnDate = String((txn.transactionDate as Record<string, unknown>)?.value ?? filingDate);

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate: txnDate,
      filingDate,
      accessionNumber: accessionNo,
      filingUrl: xmlUrl,
    });
  }

  return purchases;
}

// Public API: fetch all insider open-market purchases > minValue in the last `hours` hours
export async function getInsiderPurchases(
  hours = 24,
  minValue = 100_000
): Promise<InsiderPurchase[]> {
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const accessionNumbers = await fetchForm4FilingIds(formatDate(since), formatDate(now));

  const purchases: InsiderPurchase[] = [];
  const filingDate = formatDate(now);

  // Process in batches of 5 to stay well within EDGAR's 10 req/s limit
  const BATCH = 5;
  for (let i = 0; i < accessionNumbers.length; i += BATCH) {
    const batch = accessionNumbers.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async accNo => {
        const xmlUrl = await resolveXmlUrl(accNo);
        if (!xmlUrl) return [];
        return parsePurchases(xmlUrl, accNo, filingDate, minValue);
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') purchases.push(...r.value);
    }

    // Rate-limit gap between batches (EDGAR: ≤10 req/s)
    if (i + BATCH < accessionNumbers.length) await sleep(600);
  }

  return purchases.sort((a, b) => b.totalValue - a.totalValue);
}
