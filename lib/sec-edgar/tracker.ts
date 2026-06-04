/**
 * SEC EDGAR Insider Purchase Tracker
 *
 * Fetches Form 4 filings from EDGAR, parses XML to find open-market purchases
 * (transaction code "P"), and filters for values > $100K.
 *
 * Required env var:
 *   EDGAR_USER_AGENT  – e.g. "CompanyName admin@example.com"  (EDGAR policy)
 *   SLACK_WEBHOOK_URL – incoming webhook URL
 */

export const MIN_PURCHASE_VALUE = 100_000; // $100K threshold

const EDGAR_EFTS = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_ARCHIVE = 'https://www.sec.gov/Archives/edgar/data';
const PAGE_SIZE = 40;
const MAX_FILINGS = 500;
const REQUEST_DELAY_MS = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FilingRef {
  accessionNo: string;
  fileDate: string;
  entityName: string;
  periodOfReport: string;
}

export interface InsiderPurchase {
  company: string;
  ticker: string;
  insiderName: string;
  role: string;
  isDirector: boolean;
  isOfficer: boolean;
  shares: number;
  pricePerShare: number;
  value: number;
  transactionDate: string;
  accessionNo: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function getUserAgent(): string {
  return (
    process.env.EDGAR_USER_AGENT ||
    'Trading-Journal-Pro insider-tracker (contact@example.com)'
  );
}

async function edgarFetch(url: string, accept = '*/*'): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': getUserAgent(), Accept: accept },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res;
}

// ─── EDGAR EFTS Search ────────────────────────────────────────────────────────

async function searchForm4Page(
  startDate: string,
  endDate: string,
  from: number,
): Promise<{ total: number; hits: FilingRef[] }> {
  const url = new URL(EDGAR_EFTS);
  url.searchParams.set('q', '');
  url.searchParams.set('forms', '4');
  url.searchParams.set('dateRange', 'custom');
  url.searchParams.set('startdt', startDate);
  url.searchParams.set('enddt', endDate);
  url.searchParams.set('from', String(from));
  // EDGAR EFTS uses Elasticsearch under the hood; default page size is 10.
  // Setting size=40 reduces round-trips while staying within EDGAR's limits.
  url.searchParams.set('hits.hits.length', '40');

  const res = await edgarFetch(url.toString(), 'application/json');
  const data = await res.json();

  const hits: FilingRef[] = (data?.hits?.hits ?? [])
    .map((h: any) => ({
      accessionNo: h._source?.accession_no ?? '',
      fileDate: h._source?.file_date ?? '',
      entityName: h._source?.entity_name ?? '',
      periodOfReport: h._source?.period_of_report ?? '',
    }))
    .filter((h: FilingRef) => h.accessionNo);

  return { total: data?.hits?.total?.value ?? 0, hits };
}

export async function fetchAllForm4Refs(
  startDate: string,
  endDate: string,
  onProgress?: (fetched: number, total: number) => void,
): Promise<FilingRef[]> {
  const all: FilingRef[] = [];
  let from = 0;
  let total = Infinity;

  while (from < total && all.length < MAX_FILINGS) {
    const page = await searchForm4Page(startDate, endDate, from);
    total = page.total;
    if (page.hits.length === 0) break;
    all.push(...page.hits);
    onProgress?.(all.length, Math.min(total, MAX_FILINGS));
    // Advance by actual count returned, not a fixed PAGE_SIZE, so we don't
    // skip results if EDGAR returns fewer than PAGE_SIZE per page.
    from += page.hits.length;
    await sleep(REQUEST_DELAY_MS);
  }

  return all;
}

// ─── Filing XML retrieval ─────────────────────────────────────────────────────

function cikFromAccession(accNo: string): string {
  // Accession format: 0001234567-YY-NNNNNN  — first segment is zero-padded CIK
  return String(parseInt(accNo.split('-')[0], 10));
}

function folderFromAccession(accNo: string): string {
  return accNo.replace(/-/g, '');
}

async function findXmlFilename(
  cik: string,
  folder: string,
  accNo: string,
): Promise<string | null> {
  const indexUrl = `${EDGAR_ARCHIVE}/${cik}/${folder}/${accNo}-index.json`;
  let data: any;
  try {
    const res = await edgarFetch(indexUrl, 'application/json');
    data = await res.json();
  } catch {
    return null;
  }

  const raw = data?.directory?.item;
  const items: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  // Prefer item explicitly typed as '4', otherwise first .xml that isn't the index
  return (
    items.find(
      (i: any) =>
        i.type === '4' &&
        typeof i.name === 'string' &&
        i.name.toLowerCase().endsWith('.xml'),
    )?.name ??
    items.find(
      (i: any) =>
        typeof i.name === 'string' &&
        i.name.toLowerCase().endsWith('.xml') &&
        !i.name.toLowerCase().includes('index'),
    )?.name ??
    null
  );
}

// ─── XML Parsing ──────────────────────────────────────────────────────────────

function xmlTag(xml: string, tag: string): string {
  // Handles both <tag><value>X</value></tag> and <tag>X</tag>
  const withVal = xml.match(
    new RegExp(`<${tag}>[\\s\\S]*?<value>([^<]*)<\\/value>[\\s\\S]*?<\\/${tag}>`),
  );
  if (withVal) return withVal[1].trim();
  const plain = xml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
  return plain ? plain[1].trim() : '';
}

interface RawTransaction {
  code: string;
  acquired: boolean;
  shares: number;
  price: number;
  date: string;
}

function parseNonDerivativeTx(xml: string): RawTransaction[] {
  const results: RawTransaction[] = [];
  const re = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tx = m[1];
    results.push({
      code: xmlTag(tx, 'transactionCode'),
      acquired: xmlTag(tx, 'transactionAcquiredDisposedCode') === 'A',
      shares: parseFloat(xmlTag(tx, 'transactionShares')) || 0,
      price: parseFloat(xmlTag(tx, 'transactionPricePerShare')) || 0,
      date: xmlTag(tx, 'transactionDate'),
    });
  }
  return results;
}

function parseForm4(xml: string) {
  return {
    company: xmlTag(xml, 'issuerName'),
    ticker: xmlTag(xml, 'issuerTradingSymbol').toUpperCase(),
    insiderName: xmlTag(xml, 'rptOwnerName'),
    isDirector: xmlTag(xml, 'isDirector') === '1',
    isOfficer: xmlTag(xml, 'isOfficer') === '1',
    officerTitle: xmlTag(xml, 'officerTitle'),
    transactions: parseNonDerivativeTx(xml),
  };
}

// ─── Process a single filing ──────────────────────────────────────────────────

export async function processFiling(ref: FilingRef): Promise<InsiderPurchase[]> {
  const cik = cikFromAccession(ref.accessionNo);
  const folder = folderFromAccession(ref.accessionNo);

  await sleep(REQUEST_DELAY_MS);
  const xmlFile = await findXmlFilename(cik, folder, ref.accessionNo);
  if (!xmlFile) return [];

  await sleep(REQUEST_DELAY_MS);
  let xml: string;
  try {
    const res = await edgarFetch(
      `${EDGAR_ARCHIVE}/${cik}/${folder}/${xmlFile}`,
      'application/xml, text/xml',
    );
    xml = await res.text();
  } catch {
    return [];
  }

  const form4 = parseForm4(xml);
  const purchases: InsiderPurchase[] = [];

  for (const tx of form4.transactions) {
    // Only open-market purchases (code P) that were acquired (A) with known price
    if (tx.code !== 'P' || !tx.acquired || tx.shares <= 0 || tx.price <= 0) continue;

    const value = tx.shares * tx.price;
    if (value < MIN_PURCHASE_VALUE) continue;

    let role = 'Insider';
    if (form4.isOfficer && form4.officerTitle) role = form4.officerTitle;
    else if (form4.isDirector) role = 'Director';
    else if (form4.isOfficer) role = 'Officer';

    purchases.push({
      company: form4.company,
      ticker: form4.ticker,
      insiderName: form4.insiderName,
      role,
      isDirector: form4.isDirector,
      isOfficer: form4.isOfficer,
      shares: tx.shares,
      pricePerShare: tx.price,
      value,
      transactionDate: tx.date,
      accessionNo: ref.accessionNo,
    });
  }

  return purchases;
}

// ─── Run full scan ────────────────────────────────────────────────────────────

export async function runScan(
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
): Promise<InsiderPurchase[]> {
  onProgress?.(`Searching EDGAR for Form 4 filings (${startDate} → ${endDate})…`);

  const refs = await fetchAllForm4Refs(startDate, endDate, (n, total) =>
    onProgress?.(`  Fetched filing list: ${n} / ${total}`),
  );

  onProgress?.(`Found ${refs.length} Form 4 filings. Analyzing each for purchases…`);

  const all: InsiderPurchase[] = [];
  let done = 0;

  for (const ref of refs) {
    done++;
    if (done % 25 === 0) {
      onProgress?.(`  Processed ${done}/${refs.length} filings — ${all.length} qualifying purchases so far`);
    }
    try {
      const purchases = await processFiling(ref);
      all.push(...purchases);
    } catch {
      // Skip filings that fail to parse
    }
  }

  return all;
}

// ─── Slack formatting ─────────────────────────────────────────────────────────

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v.toFixed(0)}`;
}

export function buildSlackPayload(
  purchases: InsiderPurchase[],
  dateRange: string,
): object {
  const sorted = [...purchases].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 20);
  const totalValue = purchases.reduce((s, p) => s + p.value, 0);
  const shown = top.length;

  const lines: string[] = [
    `🏦 *SEC Insider Purchases — ${dateRange}*`,
    `_Open-market buys (code P) · Minimum $100K · Ranked by value_`,
    '',
  ];

  top.forEach((p, i) => {
    const label = p.ticker || p.company;
    lines.push(
      `${i + 1}. *${label}* | ${p.insiderName} _(${p.role})_`,
      `   ↳ ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${fmt(p.value)}*`,
    );
  });

  lines.push('');
  lines.push(
    `📊 *${purchases.length}* purchases found · Total value: *${fmt(totalValue)}*` +
      (purchases.length > shown ? ` _(showing top ${shown})_` : ''),
  );

  const text = lines.join('\n');

  return {
    text: `SEC Insider Purchases ${dateRange}: ${purchases.length} buys > $100K (total ${fmt(totalValue)})`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

export async function sendToSlack(payload: object): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL is not set');
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
  }
}
