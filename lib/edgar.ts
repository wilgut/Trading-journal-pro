/**
 * SEC EDGAR Form 4 insider-purchase fetcher.
 *
 * Flow:
 *   1. Search EDGAR EFTS (full-text search) for Form 4 filings filed in the
 *      last 24 hours.  Falls back to the public Atom feed if EFTS doesn't
 *      return JSON.
 *   2. For each filing, fetch the Form 4 XML document.
 *   3. Parse nonDerivativeTransaction blocks for open-market purchases
 *      (transactionCode = "P", transactionAcquiredDisposedCode = "A").
 *   4. Return results sorted by totalValue descending.
 *
 * Rate-limit:  3 concurrent requests, 400 ms between batches ≈ 6 req/s
 *              (well under EDGAR's 10 req/s ceiling).
 */

const SEC_URL  = 'https://www.sec.gov';
const EFTS_URL = 'https://efts.sec.gov';

// EDGAR ToS requires a descriptive User-Agent with contact info.
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ?? 'TradingJournalPro/1.0 contact@example.com';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function secFetch(url: string): Promise<string> {
  // Adds a small per-request delay so concurrent batches stay ≤ 10 req/s.
  await wait(110);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.text();
}

// ── XML helpers (Form 4 is regular enough for targeted regex) ─────────────

/** Extracts value from  <tag>text</tag>  (direct text child). */
function xmlGet(src: string, tag: string): string {
  const m = src.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i'));
  return m?.[1]?.trim() ?? '';
}

/** Extracts value from  <tag>…<value>text</value>…</tag>  (nested value tag). */
function xmlGetV(src: string, tag: string): string {
  const m = src.match(
    new RegExp(`<${tag}>[\\s\\S]*?<value>([^<]+)</value>[\\s\\S]*?</${tag}>`, 'i'),
  );
  return m?.[1]?.trim() ?? '';
}

/** Returns all occurrences of  <tag>…</tag>  blocks. */
function xmlBlocks(src: string, tag: string): string[] {
  return [...src.matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'ig'))].map(
    m => m[0],
  );
}

// ── Types ─────────────────────────────────────────────────────────────────

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
  secUrl: string;
}

// ── EDGAR EFTS search ─────────────────────────────────────────────────────

interface EftsHit {
  _id: string;
  _source: { file_date: string; entity_name?: string };
}

async function eftsSearch(
  startDate: string,
  endDate: string,
  from = 0,
): Promise<{ hits: EftsHit[]; total: number }> {
  const url = new URL(`${EFTS_URL}/EFTS/html`);
  url.searchParams.set('q', '""');
  url.searchParams.set('forms', '4');
  url.searchParams.set('dateRange', 'custom');
  url.searchParams.set('startdt', startDate);
  url.searchParams.set('enddt', endDate);
  url.searchParams.set('from', String(from));

  const text = await secFetch(url.toString());

  // EFTS returns JSON with an Elasticsearch-style hits envelope.
  // If the response is HTML (unexpected), JSON.parse will throw and
  // the caller falls back to the Atom feed.
  const data = JSON.parse(text) as {
    hits?: { hits?: EftsHit[]; total?: { value?: number } };
  };

  return {
    hits:  data?.hits?.hits  ?? [],
    total: data?.hits?.total?.value ?? 0,
  };
}

// ── Atom feed fallback ────────────────────────────────────────────────────

async function atomFallback(sinceDate: string): Promise<EftsHit[]> {
  const url =
    `${SEC_URL}/cgi-bin/browse-edgar` +
    `?action=getcurrent&type=4&dateb=&owner=include&count=40&search_text=&output=atom`;

  const text = await secFetch(url);
  const hits: EftsHit[] = [];

  for (const entry of xmlBlocks(text, 'entry')) {
    // id looks like: urn:tag:www.sec.gov,2008:accession-number=0001234567-24-000001
    const id      = xmlGet(entry, 'id');
    const updated = xmlGet(entry, 'updated');
    const match   = id.match(/accession-number=(\d{10}-\d{2}-\d{6})/);
    if (!match) continue;

    const fileDate = updated.slice(0, 10);
    if (fileDate < sinceDate) continue; // older than our window

    hits.push({ _id: match[1], _source: { file_date: fileDate } });
  }

  return hits;
}

// ── Form 4 XML fetcher ────────────────────────────────────────────────────

/**
 * Attempts to retrieve the Form 4 XML for a given accession number.
 *
 * Strategy:
 *   1. Try the conventional  form4.xml  filename directly.
 *   2. On failure, consult  index.json  to find the real XML filename.
 */
async function fetchForm4XML(accessionNo: string): Promise<string | null> {
  // accessionNo: "0001234567-24-000001"
  const filerCik = accessionNo.split('-')[0].replace(/^0+/, '');
  const pathNo   = accessionNo.replace(/-/g, '');
  const base     = `${SEC_URL}/Archives/edgar/data/${filerCik}/${pathNo}`;

  try {
    return await secFetch(`${base}/form4.xml`);
  } catch { /* fall through to index lookup */ }

  try {
    const idxRaw = await secFetch(`${base}/index.json`);
    const idx    = JSON.parse(idxRaw) as {
      directory?: { item?: Array<{ name: string }> };
    };
    const xmlFile = (idx?.directory?.item ?? []).find(
      f => f.name.endsWith('.xml') && !f.name.startsWith('xsl'),
    );
    if (xmlFile) return await secFetch(`${base}/${xmlFile.name}`);
  } catch { /* skip */ }

  return null;
}

// ── Form 4 XML parser ─────────────────────────────────────────────────────

function parseForm4(
  xml: string,
  filingDate: string,
  accessionNo: string,
): InsiderPurchase[] {
  const filerCik = accessionNo.split('-')[0].replace(/^0+/, '');
  const pathNo   = accessionNo.replace(/-/g, '');
  const secUrl   = `${SEC_URL}/Archives/edgar/data/${filerCik}/${pathNo}/`;

  const company     = xmlGet(xml, 'issuerName');
  const ticker      = (xmlGet(xml, 'issuerTradingSymbol') || '').toUpperCase();
  const insiderName = xmlGet(xml, 'rptOwnerName');
  const insiderTitle = xmlGet(xml, 'officerTitle');
  const isDirector  = xmlGet(xml, 'isDirector') === '1';
  const isOfficer   = xmlGet(xml, 'isOfficer')  === '1';

  if (!company || !insiderName) return [];

  const results: InsiderPurchase[] = [];

  for (const block of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const code        = xmlGet(block, 'transactionCode');
    const disposition = xmlGetV(block, 'transactionAcquiredDisposedCode');

    // Only open-market purchases (P) that are acquisitions (A)
    if (code !== 'P' || disposition !== 'A') continue;

    const shares = parseFloat(xmlGetV(block, 'transactionShares')        || '0');
    const price  = parseFloat(xmlGetV(block, 'transactionPricePerShare') || '0');
    const txDate = xmlGetV(block, 'transactionDate');

    if (!shares || !price) continue;

    results.push({
      company,
      ticker,
      insiderName,
      insiderTitle,
      isDirector,
      isOfficer,
      shares,
      pricePerShare: price,
      totalValue:    shares * price,
      transactionDate: txDate || filingDate,
      filingDate,
      secUrl,
    });
  }

  return results;
}

// ── Public entry point ────────────────────────────────────────────────────

export async function fetchInsiderPurchases({
  minValue   = 100_000,
  maxFilings = 150,
}: {
  minValue?:   number;
  maxFilings?: number;
} = {}): Promise<InsiderPurchase[]> {
  const now       = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = yesterday.toISOString().slice(0, 10);
  const endDate   = now.toISOString().slice(0, 10);

  // ── 1. Collect filing IDs ──────────────────────────────────────────────
  let filingHits: EftsHit[] = [];

  try {
    const first = await eftsSearch(startDate, endDate, 0);
    filingHits  = first.hits;

    const cap = Math.min(first.total, maxFilings);
    while (filingHits.length < cap) {
      const page = await eftsSearch(startDate, endDate, filingHits.length);
      if (!page.hits.length) break;
      filingHits.push(...page.hits);
    }
  } catch (e) {
    console.warn('EFTS search failed, falling back to Atom feed:', (e as Error).message);
    filingHits = await atomFallback(startDate);
  }

  const filings = filingHits.slice(0, maxFilings);

  // ── 2. Fetch & parse each Form 4 in batches of 3 ─────────────────────
  const purchases: InsiderPurchase[] = [];
  const BATCH  = 3;
  const DELAY  = 400; // ms between batches → ~6 req/s

  for (let i = 0; i < filings.length; i += BATCH) {
    const batch = filings.slice(i, i + BATCH);

    const settled = await Promise.allSettled(
      batch.map(async hit => {
        const xml = await fetchForm4XML(hit._id);
        if (!xml) return [];
        return parseForm4(xml, hit._source.file_date, hit._id);
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        purchases.push(...r.value.filter(p => p.totalValue >= minValue));
      }
    }

    if (i + BATCH < filings.length) await wait(DELAY);
  }

  // ── 3. Sort by value descending ───────────────────────────────────────
  return purchases.sort((a, b) => b.totalValue - a.totalValue);
}
