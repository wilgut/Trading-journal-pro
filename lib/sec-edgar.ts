import { XMLParser } from 'fast-xml-parser';

const EDGAR_BASE = 'https://www.sec.gov';
const EFTS_SEARCH = 'https://efts.sec.gov/LATEST/search-index';

const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ?? 'TradingJournalPro/1.0 contact@tradingjournal.pro';

export interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filedDate: string;
  secFilingUrl: string;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

async function edgarFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json,application/xml,text/html' },
    // Bypass Next.js data cache — we always want fresh SEC data
    cache: 'no-store',
  });
  if (res.status === 429) {
    await sleep(2000);
    return edgarFetch(url);
  }
  return res;
}

interface FilingHit {
  _source: {
    entity_id: string;
    file_date: string;
    accession_no: string;
  };
}

async function searchForm4Filings(startDate: string, endDate: string): Promise<FilingHit[]> {
  const params = new URLSearchParams({
    q: '', forms: '4', dateRange: 'custom',
    startdt: startDate, enddt: endDate,
    from: '0', size: '200',
  });
  const res = await edgarFetch(`${EFTS_SEARCH}?${params}`);
  if (!res.ok) throw new Error(`EDGAR search failed: ${res.status}`);
  const json = await res.json();
  return (json.hits?.hits ?? []) as FilingHit[];
}

async function getXmlDocName(cik: string, accNo: string): Promise<string | null> {
  const cikNum = cik.replace(/^0+/, '') || '0';
  const accNoDash = accNo.replace(/-/g, '');
  const url = `${EDGAR_BASE}/Archives/edgar/data/${cikNum}/${accNoDash}/${accNo}-index.json`;
  const res = await edgarFetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const items: { name: string; type: string }[] = Array.isArray(json.directory?.item)
    ? json.directory.item
    : json.directory?.item
    ? [json.directory.item]
    : [];
  return items.find(d => ['4', '4/A'].includes(d.type) && d.name.endsWith('.xml'))?.name ?? null;
}

function parseForm4Xml(xml: string): {
  companyName: string;
  ticker: string;
  insiderName: string;
  isDirector: boolean;
  isOfficer: boolean;
  officerTitle: string;
  purchases: { shares: number; pricePerShare: number; totalValue: number; transactionDate: string }[];
} | null {
  try {
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });
    const root = parser.parse(xml)?.ownershipDocument;
    if (!root) return null;

    const issuer = root.issuer ?? {};
    const owner = root.reportingOwner ?? {};
    const ownerId = owner.reportingOwnerId ?? {};
    const ownerRel = owner.reportingOwnerRelationship ?? {};

    const txns = (() => {
      const raw = root.nonDerivativeTable?.nonDerivativeTransaction;
      if (!raw) return [];
      return Array.isArray(raw) ? raw : [raw];
    })();

    const purchases = txns
      .filter((t: any) => {
        const code = String(t?.transactionCoding?.transactionCode ?? '');
        const adc = String(t?.transactionAmounts?.transactionAcquiredDisposedCode?.value ?? '');
        return code === 'P' && adc === 'A';
      })
      .map((t: any) => {
        const shares = parseFloat(String(t?.transactionAmounts?.transactionShares?.value ?? 0));
        const price = parseFloat(String(t?.transactionAmounts?.transactionPricePerShare?.value ?? 0));
        const date = String(t?.transactionDate?.value ?? '');
        return { shares, pricePerShare: price, totalValue: shares * price, transactionDate: date };
      })
      .filter((p: any) => p.shares > 0 && p.pricePerShare > 0);

    return {
      companyName: String(issuer.issuerName ?? '').trim(),
      ticker: String(issuer.issuerTradingSymbol ?? '').trim().toUpperCase(),
      insiderName: String(ownerId.rptOwnerName ?? '').trim(),
      isDirector: String(ownerRel.isDirector) === '1',
      isOfficer: String(ownerRel.isOfficer) === '1',
      officerTitle: String(ownerRel.officerTitle ?? '').trim(),
      purchases,
    };
  } catch {
    return null;
  }
}

async function processFiling(hit: FilingHit): Promise<InsiderPurchase[]> {
  const { entity_id: cik, accession_no: accNo, file_date: filedDate } = hit._source;
  const cikNum = cik.replace(/^0+/, '') || '0';
  const accNoDash = accNo.replace(/-/g, '');
  const secFilingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cikNum}/${accNoDash}/${accNo}-index.htm`;

  const docName = await getXmlDocName(cik, accNo);
  if (!docName) return [];

  const res = await edgarFetch(
    `${EDGAR_BASE}/Archives/edgar/data/${cikNum}/${accNoDash}/${docName}`
  );
  if (!res.ok) return [];

  const parsed = parseForm4Xml(await res.text());
  if (!parsed || parsed.purchases.length === 0) return [];

  const insiderTitle = parsed.isOfficer
    ? parsed.officerTitle || 'Officer'
    : parsed.isDirector
    ? 'Director'
    : 'Insider';

  return parsed.purchases.map(p => ({
    companyName: parsed.companyName,
    ticker: parsed.ticker,
    insiderName: parsed.insiderName,
    insiderTitle,
    ...p,
    filedDate,
    secFilingUrl,
  }));
}

export async function fetchInsiderPurchases(
  minValue = 100_000,
  hoursBack = 24
): Promise<InsiderPurchase[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - hoursBack * 3_600_000);
  const startDate = cutoff.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const hits = await searchForm4Filings(startDate, endDate);
  if (hits.length === 0) return [];

  const results: InsiderPurchase[] = [];
  const BATCH_SIZE = 5; // stay well under SEC's 10 req/s limit (each filing = 2 calls)

  for (let i = 0; i < hits.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(1100);
    const batch = await Promise.all(
      hits.slice(i, i + BATCH_SIZE).map(h => processFiling(h).catch(() => []))
    );
    results.push(...batch.flat());
  }

  return results
    .filter(p => p.totalValue >= minValue)
    .sort((a, b) => b.totalValue - a.totalValue);
}
