/**
 * SEC EDGAR Insider Purchase Tracker
 *
 * Fetches Form 4 filings from the last 24 hours via the EDGAR EFTS API,
 * parses each filing's XML for open-market purchases by directors/officers,
 * filters for transactions ≥ $100 k, and returns a ranked list.
 *
 * SEC requirement: all requests must carry a descriptive User-Agent.
 * Set SEC_USER_AGENT="MyApp myname@example.com" in your environment.
 */

export const MIN_PURCHASE_USD = 100_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  transactionDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  filingDate: string;
  accessionNumber: string;
  cik: string;
  edgarUrl: string;
}

interface EdgarHit {
  _id: string; // accession number e.g. "0001234567-26-000001"
  _source: {
    entity_name: string;
    file_date: string;
    period_of_report: string;
  };
}

interface EdgarSearchResponse {
  hits: {
    total: { value: number; relation: string };
    hits: EdgarHit[];
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEC_ORIGIN = "https://www.sec.gov";
const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";

function secHeaders(): HeadersInit {
  return {
    "User-Agent":
      process.env.SEC_USER_AGENT ??
      "TradingJournalPro wilfred.gutierrez@gmail.com",
    Accept: "application/json, text/plain, */*",
  };
}

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function secFetch(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { headers: secHeaders() });
    if (res.ok) return res;
    if (res.status === 429) {
      await delay(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`SEC fetch failed [${res.status}] ${url}`);
  }
  throw new Error(`SEC fetch exhausted retries: ${url}`);
}

/** Pull a text node value, handling both <tag>value</tag> and <tag><value>value</value></tag> */
function xmlVal(xml: string, tag: string): string {
  // Try <tag><value>...</value></tag> first (Form 4 style)
  const nested = xml.match(
    new RegExp(`<${tag}[^>]*>[\\s\\S]*?<value>([^<]*)<\\/value>[\\s\\S]*?<\\/${tag}>`, "i")
  );
  if (nested) return nested[1].trim();
  // Fallback: <tag>...</tag>
  const direct = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"));
  return direct ? direct[1].trim() : "";
}

function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

/** Derive CIK (no leading zeros) from accession number "0001234567-26-000001" */
function cikFromAccession(accNo: string): string {
  return accNo.split("-")[0].replace(/^0+/, "");
}

function dateStr(d: Date) {
  return d.toISOString().split("T")[0];
}

// ── EDGAR EFTS search ─────────────────────────────────────────────────────────

async function searchForm4Filings(
  startDate: string,
  endDate: string
): Promise<EdgarHit[]> {
  const allHits: EdgarHit[] = [];
  let from = 0;
  const pageSize = 40;

  while (true) {
    const params = new URLSearchParams({
      q: "",
      forms: "4",
      dateRange: "custom",
      startdt: startDate,
      enddt: endDate,
      from: String(from),
    });

    const res = await secFetch(`${EFTS_URL}?${params}`);
    const data: EdgarSearchResponse = await res.json();
    const hits = data.hits?.hits ?? [];
    allHits.push(...hits);

    const total = data.hits?.total?.value ?? 0;
    if (hits.length < pageSize || allHits.length >= total) break;
    from += pageSize;
    await delay(150); // stay under SEC's 10 req/s limit
  }

  return allHits;
}

// ── Form 4 XML parsing ────────────────────────────────────────────────────────

async function parseFilingXml(
  cik: string,
  accNo: string,
  filingDate: string
): Promise<InsiderPurchase[]> {
  const accNoDash = accNo.replace(/-/g, "");
  const indexUrl = `${SEC_ORIGIN}/Archives/edgar/data/${cik}/${accNoDash}/${accNo}-index.htm`;

  const indexRes = await secFetch(indexUrl);
  const indexHtml = await indexRes.text();

  // Locate the primary Form 4 XML document
  const xmlFileMatch =
    indexHtml.match(/href="([^"]+\.xml)"/i) ??
    indexHtml.match(/href="([^"]+4\.xml)"/i);
  if (!xmlFileMatch) return [];

  const rawPath = xmlFileMatch[1];
  const xmlUrl = rawPath.startsWith("/")
    ? `${SEC_ORIGIN}${rawPath}`
    : `${SEC_ORIGIN}/Archives/edgar/data/${cik}/${accNoDash}/${rawPath}`;

  await delay(100);
  const xmlRes = await secFetch(xmlUrl);
  const xml = await xmlRes.text();

  // Issuer info
  const companyName =
    xmlVal(xml, "issuerName") || xmlVal(xml, "companyConformanceName");
  const ticker = (xmlVal(xml, "issuerTradingSymbol") || "").toUpperCase();

  // Reporting owner info
  const insiderName = xmlVal(xml, "rptOwnerName");
  const isDirector = xmlVal(xml, "isDirector") === "1";
  const isOfficer = xmlVal(xml, "isOfficer") === "1";
  if (!isDirector && !isOfficer) return [];

  const officerTitle = xmlVal(xml, "officerTitle");
  const insiderTitle = isOfficer
    ? officerTitle || "Officer"
    : "Director";

  const edgarUrl = `${SEC_ORIGIN}/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=10`;

  const purchases: InsiderPurchase[] = [];

  // Parse each non-derivative transaction block
  for (const block of xmlBlocks(xml, "nonDerivativeTransaction")) {
    const txCode = xmlVal(block, "transactionCode");
    const adCode = xmlVal(block, "transactionAcquiredDisposedCode");

    // P = open-market purchase, A = acquired
    if (txCode !== "P" || adCode !== "A") continue;

    const shares = parseFloat(xmlVal(block, "transactionShares") || "0");
    const price = parseFloat(xmlVal(block, "transactionPricePerShare") || "0");
    const txDate = xmlVal(block, "transactionDate");

    if (shares <= 0 || price <= 0) continue;

    const totalValue = shares * price;
    if (totalValue < MIN_PURCHASE_USD) continue;

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      transactionDate: txDate,
      shares,
      pricePerShare: price,
      totalValue,
      filingDate,
      accessionNumber: accNo,
      cik,
      edgarUrl,
    });
  }

  return purchases;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchInsiderPurchases(
  hoursBack = 24,
  onProgress?: (msg: string) => void
): Promise<InsiderPurchase[]> {
  const now = new Date();
  const since = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

  const startDate = dateStr(since);
  const endDate = dateStr(now);
  onProgress?.(`Searching EDGAR Form 4 filings from ${startDate} → ${endDate}…`);

  const filings = await searchForm4Filings(startDate, endDate);
  onProgress?.(`Found ${filings.length} Form 4 filings. Parsing transactions…`);

  const allPurchases: InsiderPurchase[] = [];

  for (const hit of filings) {
    const cik = cikFromAccession(hit._id);
    try {
      await delay(150);
      const purchases = await parseFilingXml(cik, hit._id, hit._source.file_date);
      allPurchases.push(...purchases);
    } catch {
      // Skip unreadable filings silently
    }
  }

  // Sort descending by total purchase value
  allPurchases.sort((a, b) => b.totalValue - a.totalValue);

  onProgress?.(
    `Found ${allPurchases.length} qualifying purchases ≥ $${(
      MIN_PURCHASE_USD / 1000
    ).toFixed(0)}K`
  );

  return allPurchases;
}

// ── Slack message formatter ───────────────────────────────────────────────────

export function formatCurrency(value: number): string {
  if (value >= 1_000_000_000)
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function buildSlackMessage(
  purchases: InsiderPurchase[],
  asOf: string
): string {
  const medals = [
    ":first_place_medal:",
    ":second_place_medal:",
    ":third_place_medal:",
  ];

  const header =
    `*:chart_with_upwards_trend: SEC EDGAR — Executive & Director Purchases (Last 24 h)*\n` +
    `_As of ${asOf} · Min purchase $100K · Ranked by total value_\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (purchases.length === 0) {
    return (
      header +
      "_No qualifying insider purchases found in the last 24 hours._\n\n" +
      `_Source: <${SEC_ORIGIN}/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4>_`
    );
  }

  const rows = purchases.slice(0, 20).map((p, i) => {
    const rank = i < 3 ? medals[i] : `*${i + 1}.*`;
    return [
      `${rank}  *${p.ticker || "—"}* · ${p.companyName}`,
      `     :bust_in_silhouette: ${p.insiderName}  _(${p.insiderTitle})_`,
      `     :moneybag: ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${formatCurrency(p.totalValue)}*`,
      `     :calendar: Trade: ${p.transactionDate}  ·  Filed: ${p.filingDate}  ·  <${p.edgarUrl}|EDGAR>`,
    ].join("\n");
  });

  const moreNote =
    purchases.length > 20
      ? `\n\n_…and ${purchases.length - 20} more. <${SEC_ORIGIN}/cgi-bin/browse-edgar?action=getcurrent&type=4|See all on EDGAR>_`
      : "";

  const footer = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Source: <${SEC_ORIGIN}/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4> · Data is delayed per EDGAR filing schedules_`;

  return header + rows.join("\n\n") + moreNote + footer;
}
