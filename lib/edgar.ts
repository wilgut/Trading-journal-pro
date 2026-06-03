/**
 * SEC EDGAR Form 4 (insider ownership changes) client.
 *
 * Rate-limit compliance: SEC fair-access policy allows ≤10 req/sec.
 * We cap at ~8 req/sec (125 ms between requests within a batch).
 *
 * Required env var:
 *   EDGAR_CONTACT_EMAIL — included in the User-Agent per SEC guidelines.
 *   Defaults to a placeholder if unset (fine for dev; set it in prod).
 */

const EDGAR_BASE = 'https://www.sec.gov';
const EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index';
const REQUEST_GAP_MS = 125; // ~8 req/sec
const BATCH_CONCURRENCY = 5;

function userAgent(): string {
  const email = process.env.EDGAR_CONTACT_EMAIL ?? 'contact@example.com';
  return `TradingJournalPro ${email}`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function edgarFetch(url: string, retries = 3): Promise<Response> {
  const headers = {
    'User-Agent': userAgent(),
    'Accept-Encoding': 'gzip, deflate',
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res;
    if (res.status === 429) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    throw new Error(`EDGAR fetch failed ${res.status}: ${url}`);
  }
  throw new Error(`EDGAR fetch exhausted retries: ${url}`);
}

// ── EFTS search ─────────────────────────────────────────────────────────────

interface EftsSource {
  accession_no: string;
  ciks?: string[];
  entity_name?: string;
  file_date: string;
  form_type: string;
  period_of_report?: string;
  display_names?: string[];
}

interface EftsHit {
  _source: EftsSource;
}

async function searchForm4Filings(
  fromDate: string,
  toDate: string,
  from = 0,
  size = 100,
): Promise<EftsHit[]> {
  const params = new URLSearchParams({
    q: '""',
    forms: '4',
    dateRange: 'custom',
    startdt: fromDate,
    enddt: toDate,
    from: String(from),
    size: String(size),
  });
  const res = await edgarFetch(`${EFTS_BASE}?${params}`);
  const data = await res.json();
  return (data?.hits?.hits as EftsHit[]) ?? [];
}

// ── Filing-index → XML URL ───────────────────────────────────────────────────

async function resolveXmlUrl(accessionNo: string): Promise<string | null> {
  // Filer CIK is the numeric value of the first segment of the accession number.
  // Accession format: XXXXXXXXXX-YY-NNNNNN (10-digit CIK, year, sequence)
  const filerCik = parseInt(accessionNo.split('-')[0], 10);
  const accessionNoDash = accessionNo.replace(/-/g, '');
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${filerCik}/${accessionNoDash}/`;

  let html: string;
  try {
    const res = await edgarFetch(indexUrl);
    html = await res.text();
  } catch {
    return null;
  }

  // Prefer a table row whose Type column is "4" — fall back to first .xml href.
  const typeRow = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?<td[^>]*>\s*4\s*<\/td>(?:(?!<\/tr>)[\s\S])*?href="([^"]+\.xml)"(?:(?!<\/tr>)[\s\S])*?<\/tr>/i,
  );
  const firstXml = html.match(/href="([^"]+\.xml)"/i);

  const xmlPath = typeRow?.[1] ?? firstXml?.[1] ?? null;
  if (!xmlPath) return null;
  return xmlPath.startsWith('http') ? xmlPath : `${EDGAR_BASE}${xmlPath}`;
}

// ── XML parsing ──────────────────────────────────────────────────────────────

function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>\\s*([^<]+)\\s*</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

interface ParsedPurchase {
  shares: number;
  pricePerShare: number;
  date: string;
}

function extractPurchases(xml: string): ParsedPurchase[] {
  const results: ParsedPurchase[] = [];

  const tableMatch = xml.match(
    /<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/i,
  );
  if (!tableMatch) return results;

  const transRe =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m: RegExpExecArray | null;

  while ((m = transRe.exec(tableMatch[1])) !== null) {
    const t = m[1];

    const code =
      t.match(/<transactionCode>\s*([^<]+)\s*<\/transactionCode>/i)?.[1]?.trim() ?? '';
    const adCode =
      t.match(
        /<transactionAcquiredDisposedCode>\s*<value>\s*([^<]+)\s*<\/value>/i,
      )?.[1]?.trim() ?? '';

    // Only open-market purchases acquired (not disposals)
    if (code !== 'P' || adCode !== 'A') continue;

    const shares = parseFloat(
      t
        .match(/<transactionShares>\s*<value>\s*([^<]+)\s*<\/value>/i)?.[1]
        ?.replace(/,/g, '') ?? '0',
    );
    const price = parseFloat(
      t
        .match(
          /<transactionPricePerShare>\s*<value>\s*([^<]+)\s*<\/value>/i,
        )?.[1]
        ?.replace(/,/g, '') ?? '0',
    );
    const date =
      t
        .match(/<transactionDate>\s*<value>\s*([^<]+)\s*<\/value>/i)?.[1]
        ?.trim() ?? '';

    if (shares > 0 && price > 0) {
      results.push({ shares, pricePerShare: price, date });
    }
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface InsiderTransaction {
  rank?: number;
  filerName: string;
  companyName: string;
  ticker: string;
  transactionDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  relationship: string;
  officerTitle: string;
  filingDate: string;
  filingUrl: string;
}

async function processOneFiling(
  hit: EftsHit,
  minValue: number,
): Promise<InsiderTransaction | null> {
  const { accession_no, file_date } = hit._source;

  const xmlUrl = await resolveXmlUrl(accession_no);
  if (!xmlUrl) return null;

  await sleep(REQUEST_GAP_MS);

  let xml: string;
  try {
    const res = await edgarFetch(xmlUrl);
    xml = await res.text();
  } catch {
    return null;
  }

  // Skip if not filed by a director, officer, or 10% owner
  const isDirector = /<isDirector>\s*1\s*<\/isDirector>/i.test(xml);
  const isOfficer = /<isOfficer>\s*1\s*<\/isOfficer>/i.test(xml);
  const isTenPct = /<isTenPercentOwner>\s*1\s*<\/isTenPercentOwner>/i.test(xml);
  if (!isDirector && !isOfficer && !isTenPct) return null;

  const purchases = extractPurchases(xml);
  if (purchases.length === 0) return null;

  let totalShares = 0;
  let totalValue = 0;
  let latestDate = '';
  for (const p of purchases) {
    totalShares += p.shares;
    totalValue += p.shares * p.pricePerShare;
    if (!latestDate || p.date > latestDate) latestDate = p.date;
  }

  if (totalValue < minValue) return null;

  const avgPrice = totalShares > 0 ? totalValue / totalShares : 0;
  const officerTitle = xmlText(xml, 'officerTitle');
  const relationship =
    isDirector && isOfficer
      ? `Director & ${officerTitle || 'Officer'}`
      : isDirector
        ? 'Director'
        : isOfficer
          ? officerTitle || 'Officer'
          : '10% Owner';

  const filerCik = parseInt(accession_no.split('-')[0], 10);
  const accessionNoDash = accession_no.replace(/-/g, '');

  return {
    filerName: xmlText(xml, 'rptOwnerName'),
    companyName: xmlText(xml, 'issuerName'),
    ticker: xmlText(xml, 'issuerTradingSymbol').toUpperCase(),
    transactionDate: latestDate,
    shares: totalShares,
    pricePerShare: avgPrice,
    totalValue,
    relationship,
    officerTitle,
    filingDate: file_date,
    filingUrl: `${EDGAR_BASE}/Archives/edgar/data/${filerCik}/${accessionNoDash}/`,
  };
}

export async function getRecentInsiderPurchases(
  minValue = 100_000,
  maxFilings = 200,
): Promise<InsiderTransaction[]> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const toDate = now.toISOString().split('T')[0];
  const fromDate = yesterday.toISOString().split('T')[0];

  // Fetch up to maxFilings results (paginate in batches of 100)
  const hits: EftsHit[] = [];
  for (let offset = 0; offset < maxFilings; offset += 100) {
    const batch = await searchForm4Filings(
      fromDate,
      toDate,
      offset,
      Math.min(100, maxFilings - offset),
    );
    hits.push(...batch);
    if (batch.length < 100) break;
    await sleep(REQUEST_GAP_MS);
  }

  const results: InsiderTransaction[] = [];

  // Process concurrently in small batches to respect rate limits
  for (let i = 0; i < hits.length; i += BATCH_CONCURRENCY) {
    const chunk = hits.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((hit) => processOneFiling(hit, minValue)),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      }
    }
    if (i + BATCH_CONCURRENCY < hits.length) {
      await sleep(REQUEST_GAP_MS * BATCH_CONCURRENCY);
    }
  }

  results.sort((a, b) => b.totalValue - a.totalValue);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  return results;
}
