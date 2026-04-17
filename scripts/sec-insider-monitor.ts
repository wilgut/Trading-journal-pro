#!/usr/bin/env npx tsx
/**
 * SEC EDGAR Insider Purchase Monitor
 *
 * Fetches Form 4 filings from the last 24 hours via SEC EDGAR EFTS API,
 * filters for open-market purchases > $100k by executives/directors,
 * and sends a ranked summary to Slack.
 *
 * Usage:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... npx tsx scripts/sec-insider-monitor.ts
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL  — Slack incoming webhook URL
 *
 * Optional env vars:
 *   MIN_PURCHASE_VALUE — Minimum USD value to include (default: 100000)
 *   MAX_FILINGS        — Max Form 4 filings to process (default: 200)
 *   EDGAR_USER_AGENT   — SEC requires identifying yourself (default provided)
 */

const EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";
const MIN_PURCHASE_VALUE = Number(process.env.MIN_PURCHASE_VALUE ?? 100_000);
const MAX_FILINGS = Number(process.env.MAX_FILINGS ?? 200);
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ??
  "Trading-Journal-Pro insider-monitor@trading-journal-pro.com";

// ── Types ────────────────────────────────────────────────────────────────────

interface EdgarSearchHit {
  _id: string;
  _source: {
    entity_name?: string;
    file_date?: string;
    period_of_report?: string;
    accession_no?: string;
    display_names?: Array<{ name: string; id: string }>;
  };
}

interface EdgarSearchResponse {
  hits: {
    total: { value: number; relation: string };
    hits: EdgarSearchHit[];
  };
}

interface FilingIndexDoc {
  name: string;
  type: string;
}

interface InsiderPurchase {
  executiveName: string;
  title: string;
  company: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  filingDate: string;
  filingUrl: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function secFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/html, application/xml",
    },
  });
}

/** Extract the first text content of a named XML tag (handles attributes). */
function xmlValue(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i");
  return xml.match(re)?.[1]?.trim() ?? "";
}

/** Extract ALL occurrences of a block between open/close tags. */
function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

/** Parse accession number → filer CIK and normalised path segment. */
function parseAccession(accNo: string): { cik: string; pathSeg: string } | null {
  // Format: 0001234567-26-000001
  const m = accNo.match(/^(\d{10})-(\d{2}-\d{6})$/);
  if (!m) return null;
  const cik = String(parseInt(m[1], 10)); // strip leading zeros for archive path
  const pathSeg = (m[1] + m[2]).replace(/-/g, ""); // 000123456726000001
  return { cik, pathSeg };
}

/** Fetch the filing index JSON and return the primary Form 4 XML filename. */
async function getPrimaryXmlName(
  cik: string,
  pathSeg: string,
  accNo: string
): Promise<string | null> {
  const indexUrl = `${EDGAR_ARCHIVES}/${cik}/${pathSeg}/${accNo}-index.json`;
  try {
    const res = await secFetch(indexUrl);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      directory?: { item?: FilingIndexDoc[] };
    };
    const items = data?.directory?.item ?? [];
    const xmlDoc =
      items.find((d) => d.type === "4" && d.name.endsWith(".xml")) ??
      items.find((d) => d.name.endsWith(".xml"));
    return xmlDoc?.name ?? null;
  } catch {
    return null;
  }
}

/** Parse a Form 4 XML string → list of open-market purchases. */
function parseForm4Xml(xml: string, filingDate: string, accNo: string, cik: string): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = [];

  // Issuer / company info
  const company = xmlValue(xml, "issuerName");
  const ticker = xmlValue(xml, "issuerTradingSymbol");

  // Reporting owner info (may be multiple, take first)
  const ownerBlock = xmlBlocks(xml, "reportingOwner")[0] ?? "";
  const executiveName = xmlValue(ownerBlock, "rptOwnerName");
  const isDirector = xmlValue(ownerBlock, "isDirector") === "1";
  const isOfficer = xmlValue(ownerBlock, "isOfficer") === "1";
  const officerTitle = xmlValue(ownerBlock, "officerTitle");
  const title = officerTitle || (isDirector ? "Director" : isOfficer ? "Officer" : "Insider");

  // Only care about non-derivative transactions (stock, not options)
  const txBlocks = xmlBlocks(xml, "nonDerivativeTransaction");
  const pathSeg = parseAccession(accNo)?.pathSeg ?? accNo.replace(/-/g, "");
  const filingUrl = `${EDGAR_ARCHIVES}/${cik}/${pathSeg}/${accNo}-index.htm`;

  for (const tx of txBlocks) {
    const code = xmlValue(tx, "transactionCode");
    const acquired = xmlValue(tx, "transactionAcquiredDisposedCode");

    // "P" = open-market purchase; "A" = acquired (as opposed to "D" disposed)
    if (code !== "P" || acquired !== "A") continue;

    const sharesStr = xmlValue(tx, "transactionShares");
    const priceStr = xmlValue(tx, "transactionPricePerShare");
    const shares = parseFloat(sharesStr);
    const pricePerShare = parseFloat(priceStr);

    if (!isFinite(shares) || !isFinite(pricePerShare) || shares <= 0 || pricePerShare <= 0) continue;

    const totalValue = shares * pricePerShare;
    if (totalValue < MIN_PURCHASE_VALUE) continue;

    purchases.push({
      executiveName,
      title,
      company,
      ticker: ticker.toUpperCase(),
      shares,
      pricePerShare,
      totalValue,
      filingDate,
      filingUrl,
    });
  }

  return purchases;
}

// ── SEC EDGAR Fetch ──────────────────────────────────────────────────────────

async function searchRecentForm4s(startDate: string, endDate: string): Promise<EdgarSearchHit[]> {
  const hits: EdgarSearchHit[] = [];
  const pageSize = 40;
  let from = 0;
  let total = Infinity;

  while (hits.length < total && hits.length < MAX_FILINGS) {
    const url =
      `${EDGAR_SEARCH_URL}?q=&forms=4&dateRange=custom` +
      `&startdt=${startDate}&enddt=${endDate}&from=${from}&hits.hits.total.value=true`;

    const res = await secFetch(url);
    if (!res.ok) break;
    const data = (await res.json()) as EdgarSearchResponse;

    const batch = data.hits?.hits ?? [];
    if (batch.length === 0) break;

    total = data.hits?.total?.value ?? 0;
    hits.push(...batch);
    from += pageSize;

    await sleep(150); // respect SEC rate limit (≤10 req/s)
  }

  return hits;
}

async function processFilings(hits: EdgarSearchHit[]): Promise<InsiderPurchase[]> {
  const allPurchases: InsiderPurchase[] = [];

  for (const hit of hits) {
    const accNo = hit._id;
    const parsed = parseAccession(accNo);
    if (!parsed) continue;

    const { cik, pathSeg } = parsed;
    const fileDate = hit._source.file_date ?? "";

    await sleep(120);

    const xmlName = await getPrimaryXmlName(cik, pathSeg, accNo);
    if (!xmlName) continue;

    await sleep(120);

    try {
      const xmlUrl = `${EDGAR_ARCHIVES}/${cik}/${pathSeg}/${xmlName}`;
      const xmlRes = await secFetch(xmlUrl);
      if (!xmlRes.ok) continue;

      const xmlText = await xmlRes.text();
      const purchases = parseForm4Xml(xmlText, fileDate, accNo, cik);
      allPurchases.push(...purchases);
    } catch {
      // skip malformed filings
    }
  }

  return allPurchases;
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatUSD(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(2)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function buildSlackBlocks(purchases: InsiderPurchase[], fromDate: string, toDate: string) {
  const ranked = [...purchases].sort((a, b) => b.totalValue - a.totalValue);
  const total = ranked.reduce((s, p) => s + p.totalValue, 0);

  const headerText =
    `*SEC EDGAR — Insider Purchases* (>${formatUSD(MIN_PURCHASE_VALUE)})\n` +
    `_Filings from ${fromDate} → ${toDate} · ${ranked.length} qualifying trades · ` +
    `Total: ${formatUSD(total)}_`;

  const blocks: object[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headerText },
    },
    { type: "divider" },
  ];

  if (ranked.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_No insider purchases above ${formatUSD(MIN_PURCHASE_VALUE)} found in this period._`,
      },
    });
    return blocks;
  }

  ranked.slice(0, 25).forEach((p, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    const line =
      `${medal} *<${p.filingUrl}|${p.ticker}>* — ${p.company}\n` +
      `     ${p.executiveName} _(${p.title})_\n` +
      `     *${formatUSD(p.totalValue)}* · ${formatNumber(p.shares)} shares @ $${p.pricePerShare.toFixed(2)} · Filed ${p.filingDate}`;

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: line },
    });
  });

  if (ranked.length > 25) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_…and ${ranked.length - 25} more. Showing top 25 by value._`,
        },
      ],
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "_Source: SEC EDGAR Form 4 · Open-market purchases only (transaction code P) · Not investment advice_",
      },
    ],
  });

  return blocks;
}

async function sendToSlack(blocks: object[], text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("\n── Slack payload (no SLACK_WEBHOOK_URL set) ──");
    console.log(JSON.stringify({ text, blocks }, null, 2));
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
  console.log("✓ Slack message sent");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const fromDate = fmt(yesterday);
  const toDate = fmt(now);

  console.log(`Searching SEC EDGAR Form 4 filings: ${fromDate} → ${toDate}`);
  console.log(`Minimum purchase value: ${formatUSD(MIN_PURCHASE_VALUE)}`);

  const hits = await searchRecentForm4s(fromDate, toDate);
  console.log(`Found ${hits.length} Form 4 filings to examine…`);

  const purchases = await processFilings(hits);
  console.log(`Qualifying purchases (>${formatUSD(MIN_PURCHASE_VALUE)}): ${purchases.length}`);

  const blocks = buildSlackBlocks(purchases, fromDate, toDate);
  const summaryText =
    purchases.length > 0
      ? `SEC insider purchases (last 24h): ${purchases.length} trades above ${formatUSD(MIN_PURCHASE_VALUE)}`
      : `No insider purchases above ${formatUSD(MIN_PURCHASE_VALUE)} found in the last 24h`;

  await sendToSlack(blocks, summaryText);

  // Print ranked table to console regardless
  const ranked = [...purchases].sort((a, b) => b.totalValue - a.totalValue);
  if (ranked.length > 0) {
    console.log("\n── Top Insider Purchases ──");
    ranked.forEach((p, i) => {
      console.log(
        `${String(i + 1).padStart(3)}. ${p.ticker.padEnd(6)} ${formatUSD(p.totalValue).padStart(10)} ` +
          `${p.executiveName} (${p.title}) — ${p.company}`
      );
    });
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
