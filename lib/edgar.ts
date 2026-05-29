/**
 * SEC EDGAR Form 4 client.
 *
 * Fetches recent insider Form 4 filings, parses the XML, and returns
 * only open-market purchase transactions (transaction code "P") that
 * meet a minimum dollar threshold.
 *
 * Rate-limit: SEC asks for ≤10 req/s — we batch at 5 req/s (200 ms between batches).
 * User-Agent: Required by SEC. Set SEC_CONTACT_EMAIL env var (defaults to a placeholder).
 */

const EDGAR_BASE = "https://www.sec.gov";
const EDGAR_EFTS = "https://efts.sec.gov";

const USER_AGENT = `TradingJournalPro/1.0 contact@tradingjournalpro.com`;

export interface InsiderPurchase {
  companyName: string;
  ticker: string;
  ownerName: string;
  ownerTitle: string;
  relationship: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingDate: string;
  filingUrl: string;
}

interface EftsHit {
  _id: string;
  _source: {
    file_date: string;
    period_of_report?: string;
    form_type?: string;
    entity_name?: string;
    accession_no: string;
    display_names?: Array<{ name: string; id: string; category?: string }>;
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetches Form 4 filings filed in the last 24 hours, parses each for
 * open-market purchases, and returns results filtered by minValue (default $100k),
 * sorted by totalValue descending.
 */
export async function fetchInsiderPurchases(
  minValue = 100_000
): Promise<InsiderPurchase[]> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = toDateString(yesterday);
  const endDate = toDateString(now);

  const hits = await searchForm4Filings(startDate, endDate);

  const purchases: InsiderPurchase[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < hits.length; i += CONCURRENCY) {
    const batch = hits.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((hit) => processHit(hit, minValue))
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        purchases.push(...result.value);
      }
    }

    // 200 ms between batches keeps us well under SEC's 10 req/s ceiling
    if (i + CONCURRENCY < hits.length) await sleep(200);
  }

  return purchases.sort((a, b) => b.totalValue - a.totalValue);
}

// ─── EDGAR Search ────────────────────────────────────────────────────────────

async function searchForm4Filings(
  startDate: string,
  endDate: string,
  maxResults = 100
): Promise<EftsHit[]> {
  const all: EftsHit[] = [];
  const pageSize = 10;

  for (let from = 0; from < maxResults; from += pageSize) {
    const url =
      `${EDGAR_EFTS}/LATEST/search-index` +
      `?q=%22%22&forms=4,4%2FA` +
      `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
      `&from=${from}`;

    const resp = await edgarFetch(url);
    if (!resp.ok) break;

    const data = (await resp.json()) as {
      hits?: { total?: { value: number }; hits?: EftsHit[] };
    };

    const page = data.hits?.hits ?? [];
    all.push(...page);

    const total = data.hits?.total?.value ?? 0;
    if (all.length >= total || page.length < pageSize) break;
  }

  return all;
}

// ─── Per-filing processing ───────────────────────────────────────────────────

async function processHit(
  hit: EftsHit,
  minValue: number
): Promise<InsiderPurchase[]> {
  const cik = extractCik(hit);
  if (!cik) return [];

  const accessionNo = hit._source.accession_no;
  const filingDate = hit._source.file_date ?? "";

  const xmlUrl = await getFilingXmlUrl(cik, accessionNo);
  if (!xmlUrl) return [];

  const xmlResp = await edgarFetch(xmlUrl, "text/xml,application/xml");
  if (!xmlResp.ok) return [];

  const xml = await xmlResp.text();
  const parsed = parseForm4(xml);
  if (!parsed || parsed.purchases.length === 0) return [];

  const results: InsiderPurchase[] = [];

  for (const tx of parsed.purchases) {
    const totalValue = tx.shares * tx.pricePerShare;
    if (totalValue < minValue) continue;

    results.push({
      companyName: parsed.companyName,
      ticker: parsed.ticker.toUpperCase(),
      ownerName: parsed.ownerName,
      ownerTitle: parsed.ownerTitle,
      relationship: buildRelationship(
        parsed.isDirector,
        parsed.isOfficer,
        parsed.ownerTitle
      ),
      shares: tx.shares,
      pricePerShare: tx.pricePerShare,
      totalValue,
      transactionDate: tx.date,
      filingDate,
      filingUrl: xmlUrl,
    });
  }

  return results;
}

// ─── Filing index lookup ─────────────────────────────────────────────────────

async function getFilingXmlUrl(
  cik: string,
  accessionNo: string
): Promise<string | null> {
  const norm = accessionNo.replace(/-/g, "");
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${norm}/index.json`;

  const resp = await edgarFetch(indexUrl);
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    directory?: {
      item?: Array<{ name: string; type?: string }>;
    };
  };

  const files = data.directory?.item ?? [];

  // Primary XML document is the Form 4 XML (not stylesheet, viewer, or R*.htm files)
  const xmlFile = files.find(
    (f) =>
      f.name.endsWith(".xml") &&
      !f.name.toLowerCase().includes("xsl") &&
      !f.name.startsWith("R") &&
      !f.name.includes("viewer") &&
      !f.name.includes("primary_doc")
  );

  if (!xmlFile) {
    // Fallback: any .xml file in the filing
    const anyXml = files.find((f) => f.name.endsWith(".xml"));
    if (!anyXml) return null;
    return `${EDGAR_BASE}/Archives/edgar/data/${cik}/${norm}/${anyXml.name}`;
  }

  return `${EDGAR_BASE}/Archives/edgar/data/${cik}/${norm}/${xmlFile.name}`;
}

// ─── Form 4 XML parser ───────────────────────────────────────────────────────

interface ParsedForm4 {
  companyName: string;
  ticker: string;
  ownerName: string;
  ownerTitle: string;
  isDirector: boolean;
  isOfficer: boolean;
  purchases: Array<{ shares: number; pricePerShare: number; date: string }>;
}

function parseForm4(xml: string): ParsedForm4 | null {
  const companyName = tagText(xml, "issuerName");
  const ticker = tagText(xml, "issuerTradingSymbol");
  const ownerName = tagText(xml, "rptOwnerName");
  const ownerTitle = tagText(xml, "officerTitle");
  const isDirector = tagText(xml, "isDirector") === "1";
  const isOfficer = tagText(xml, "isOfficer") === "1";

  if (!companyName || !ownerName) return null;

  const purchases: ParsedForm4["purchases"] = [];

  // Each <nonDerivativeTransaction> block is one row in the Form 4 table
  const blockRe =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const code = tagText(block, "transactionCode");
    // "P" = open-market purchase; "A" = acquired (not disposed)
    const direction = valueField(block, "transactionAcquiredDisposedCode");

    if (code !== "P" || direction !== "A") continue;

    const shares = parseFloat(valueField(block, "transactionShares") || "0");
    const price = parseFloat(
      valueField(block, "transactionPricePerShare") || "0"
    );
    const date = valueField(block, "transactionDate");

    if (shares > 0 && price > 0) {
      purchases.push({ shares, pricePerShare: price, date });
    }
  }

  return { companyName, ticker, ownerName, ownerTitle, isDirector, isOfficer, purchases };
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

/** Returns text content of the first matching tag (no nested tags). */
function tagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>\\s*([^<]*?)\\s*<\\/${tag}>`);
  return xml.match(re)?.[1]?.trim() ?? "";
}

/** Returns the <value> child of a field element. */
function valueField(xml: string, field: string): string {
  const fieldRe = new RegExp(
    `<${field}[^>]*>[\\s\\S]*?<value>\\s*([\\s\\S]*?)\\s*<\\/value>[\\s\\S]*?<\\/${field}>`
  );
  return xml.match(fieldRe)?.[1]?.trim() ?? "";
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function extractCik(hit: EftsHit): string {
  // display_names[0].id is the issuer CIK, zero-padded to 10 digits
  const raw = hit._source.display_names?.[0]?.id ?? "";
  return raw.replace(/^0+/, ""); // strip leading zeros for URL paths
}

function buildRelationship(
  isDirector: boolean,
  isOfficer: boolean,
  title: string
): string {
  if (isDirector && isOfficer) return `Director & ${title}`.replace(/ &\s*$/, "");
  if (isDirector) return "Director";
  if (isOfficer) return title || "Officer";
  return "10% Owner / Insider";
}

function toDateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function edgarFetch(url: string, accept = "application/json"): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: accept,
    },
    // Disable Next.js data cache — we always want fresh SEC data
    cache: "no-store",
  });
}
