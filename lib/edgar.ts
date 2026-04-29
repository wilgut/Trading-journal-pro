// SEC EDGAR Form 4 (insider transaction) fetcher and parser.
// Targets only purchase transactions (transactionCode=P) by directors and officers.

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_FILES = 'https://www.sec.gov/Archives/edgar/data';
// EDGAR requires a User-Agent header identifying the accessing party
const EDGAR_HEADERS = {
  'User-Agent': 'TradingJournalPro admin@tradingjournalpro.com',
  Accept: 'application/json',
};

export interface InsiderBuy {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  isDirector: boolean;
  isOfficer: boolean;
  transactionDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  cik: string;
  accessionNo: string;
  filingUrl: string;
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function xmlValue(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*<\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function xmlSection(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

function xmlSections(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${tag}>`, 'ig');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ── Network helpers ───────────────────────────────────────────────────────────

async function fetchRetry(url: string, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, { headers: EDGAR_HEADERS });
      if (res.ok) return res;
    } catch (e) {
      lastErr = e;
    }
    if (i < maxAttempts - 1) await delay(800 * 2 ** i);
  }
  throw lastErr ?? new Error(`Failed: ${url}`);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Filing XML retrieval ──────────────────────────────────────────────────────

async function fetchFilingXML(cik: string, accessionNo: string): Promise<string | null> {
  const slug = accessionNo.replace(/-/g, '');
  const indexUrl = `${EDGAR_FILES}/${cik}/${slug}/${accessionNo}-index.json`;

  try {
    const idxRes = await fetchRetry(indexUrl);
    const idx = await idxRes.json();
    const items: Array<{ name: string; type: string }> = idx?.directory?.item ?? [];

    // Prefer a file explicitly named *.xml that is not an index/header
    const xmlFile = items.find(
      (f) => f.name.endsWith('.xml') && !/^(primary_doc|index|header)/i.test(f.name),
    );

    const fileName = xmlFile?.name ?? `${slug}.xml`;
    const xmlUrl = `${EDGAR_FILES}/${cik}/${slug}/${fileName}`;
    const xmlRes = await fetchRetry(xmlUrl);
    return await xmlRes.text();
  } catch {
    return null;
  }
}

// ── Form 4 parser ─────────────────────────────────────────────────────────────

function parseForm4(xml: string, cik: string, accessionNo: string): InsiderBuy | null {
  const issuer = xmlSection(xml, 'issuer');
  const companyName = xmlValue(issuer, 'issuerName');
  const ticker = xmlValue(issuer, 'issuerTradingSymbol').toUpperCase();

  const owner = xmlSection(xml, 'reportingOwner');
  const insiderName = xmlValue(owner, 'rptOwnerName');
  const isDirector = xmlValue(owner, 'isDirector') === '1';
  const isOfficer = xmlValue(owner, 'isOfficer') === '1';
  const officerTitle = xmlValue(owner, 'officerTitle');

  // Only track directors and officers (not 10% owners who are neither)
  if (!isDirector && !isOfficer) return null;

  const insiderTitle = officerTitle || (isDirector ? 'Director' : 'Executive');

  let totalShares = 0;
  let totalValue = 0;
  let latestDate = '';

  for (const tx of xmlSections(xml, 'nonDerivativeTransaction')) {
    const code = xmlValue(tx, 'transactionCode');
    const adCode = xmlValue(tx, 'transactionAcquiredDisposedCode');

    // P = open-market purchase; A = acquired (direction)
    if (code !== 'P' || adCode !== 'A') continue;

    const shares = parseFloat(xmlValue(tx, 'transactionShares')) || 0;
    const price = parseFloat(xmlValue(tx, 'transactionPricePerShare')) || 0;
    const date = xmlValue(tx, 'transactionDate');

    if (shares > 0 && price > 0) {
      totalShares += shares;
      totalValue += shares * price;
      if (!latestDate || date > latestDate) latestDate = date;
    }
  }

  if (totalValue === 0 || !companyName) return null;

  return {
    companyName,
    ticker,
    insiderName,
    insiderTitle,
    isDirector,
    isOfficer,
    transactionDate: latestDate,
    shares: totalShares,
    pricePerShare: totalValue / totalShares,
    totalValue,
    cik,
    accessionNo,
    filingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=10`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getInsiderBuys(options?: {
  since?: Date;
  minValueUSD?: number;
  maxFilings?: number;
}): Promise<InsiderBuy[]> {
  const { since, minValueUSD = 100_000, maxFilings = 300 } = options ?? {};

  const today = new Date();
  const startDate = since ?? new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = today.toISOString().split('T')[0];

  const buys: InsiderBuy[] = [];
  let from = 0;
  const pageSize = 50;

  outer: while (from < maxFilings) {
    const url =
      `${EDGAR_SEARCH}?forms=4` +
      `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
      `&from=${from}&hits.hits.total.value=true`;

    const res = await fetchRetry(url);
    const data = await res.json();
    const hits: any[] = data?.hits?.hits ?? [];
    const total: number = data?.hits?.total?.value ?? 0;

    if (hits.length === 0) break;

    // Fetch filings in small concurrent batches to respect EDGAR rate limits
    const CONCURRENCY = 5;
    for (let i = 0; i < hits.length; i += CONCURRENCY) {
      const batch = hits.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (hit: any) => {
          const src = hit._source ?? {};
          const accessionNo: string = src.accession_no ?? hit._id ?? '';
          // entity_id is the CIK of the issuer (company) for Form 4 filings
          const cik: string = (src.entity_id ?? '').replace(/^0+/, '');

          if (!accessionNo || !cik) return null;

          const xml = await fetchFilingXML(cik, accessionNo);
          if (!xml) return null;

          return parseForm4(xml, cik, accessionNo);
        }),
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value && r.value.totalValue >= minValueUSD) {
          buys.push(r.value);
        }
      }

      // Brief pause between batches to avoid overwhelming EDGAR
      await delay(200);
    }

    from += pageSize;
    if (from >= total) break outer;
  }

  // Rank by total purchase value, largest first
  return buys.sort((a, b) => b.totalValue - a.totalValue);
}
