#!/usr/bin/env npx tsx
/**
 * SEC EDGAR Insider Purchase Alert
 *
 * Fetches Form 4 filings from the last 24 hours, filters for open-market
 * purchases >$100k by executives/directors, and sends a ranked summary to Slack.
 *
 * Usage:
 *   npm run insider-alert
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL        Slack incoming webhook URL
 *   SEC_USER_AGENT_EMAIL     Your email (required by SEC's fair-use policy)
 *
 * Schedule via cron (daily at 8 AM):
 *   0 8 * * * cd /path/to/app && npm run insider-alert
 */

import { XMLParser } from "fast-xml-parser";

// ─── Config ────────────────────────────────────────────────────────────────

const MIN_PURCHASE_USD = 100_000;
const MAX_FILINGS = 400;
const DELAY_MS = 200; // 5 req/s — well under SEC's 10/s limit
const TOP_N_IN_SLACK = 25; // max entries shown in Slack message

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";
const SEC_EMAIL = process.env.SEC_USER_AGENT_EMAIL ?? "user@example.com";
const USER_AGENT = `TradingJournalPro/1.0 (${SEC_EMAIL})`;

const EDGAR_BASE = "https://www.sec.gov";
const EFTS_BASE = "https://efts.sec.gov/LATEST/search-index";

// ─── Types ──────────────────────────────────────────────────────────────────

interface FilingMeta {
  accessionNumber: string;
  filingDate: string;
}

interface Purchase {
  insiderName: string;
  title: string;
  isDirector: boolean;
  isOfficer: boolean;
  companyName: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingDate: string;
  filingUrl: string;
}

// ─── Rate-limited fetch ──────────────────────────────────────────────────────

let _lastReqAt = 0;

async function secFetch(url: string, retries = 3): Promise<Response> {
  const elapsed = Date.now() - _lastReqAt;
  if (elapsed < DELAY_MS) {
    await new Promise((r) => setTimeout(r, DELAY_MS - elapsed));
  }
  _lastReqAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 2_000));
      return secFetch(url, retries - 1);
    }
    throw err;
  }

  if (res.status === 429) {
    const wait = 15_000;
    console.warn(`Rate limited by SEC, waiting ${wait / 1000}s…`);
    await new Promise((r) => setTimeout(r, wait));
    return secFetch(url, retries);
  }

  return res;
}

// ─── Step 1: Collect Form 4 filing metadata ──────────────────────────────────

async function fetchRecentForm4s(since: Date): Promise<FilingMeta[]> {
  const startDt = since.toISOString().slice(0, 10);
  const endDt = new Date().toISOString().slice(0, 10);
  const filings: FilingMeta[] = [];
  let from = 0;
  let total = Infinity;

  console.log(`\n📥 Fetching Form 4 filings from ${startDt} to ${endDt}…`);

  while (from < Math.min(total, MAX_FILINGS)) {
    const url = `${EFTS_BASE}?q=&forms=4&dateRange=custom&startdt=${startDt}&enddt=${endDt}&from=${from}&size=20`;
    const res = await secFetch(url);

    if (!res.ok) {
      console.warn(`  EFTS search returned ${res.status}, stopping pagination.`);
      break;
    }

    const json = (await res.json()) as {
      hits: { total: { value: number }; hits: Array<{ _id: string; _source: { file_date?: string } }> };
    };

    total = json.hits?.total?.value ?? 0;
    const hits = json.hits?.hits ?? [];
    if (!hits.length) break;

    for (const h of hits) {
      if (h._id) {
        filings.push({
          accessionNumber: h._id,
          filingDate: h._source?.file_date ?? "",
        });
      }
    }

    from += 20;
    process.stdout.write(`  ${filings.length}/${Math.min(total, MAX_FILINGS)} filings queued…\r`);
  }

  process.stdout.write("\n");
  console.log(`  Found ${filings.length} Form 4 filings (total available: ${total}).`);
  return filings;
}

// ─── Step 2: Resolve primary XML URL for each filing ─────────────────────────

function cikFromAccession(accNo: string): string {
  // Accession format: XXXXXXXXXX-YY-NNNNNN; first segment is filer CIK (zero-padded)
  return String(parseInt(accNo.split("-")[0], 10));
}

async function fetchFilingXml(cik: string, accNo: string): Promise<string | null> {
  const flat = accNo.replace(/-/g, "");
  const dirBase = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${flat}`;

  // 1) Try the filing index page — the first .xml href is the primary document
  try {
    const idxRes = await secFetch(`${dirBase}/${accNo}-index.htm`);
    if (idxRes.ok) {
      const html = await idxRes.text();
      const m = html.match(/href="([^"]+\.xml)"/i);
      if (m) {
        const href = m[1];
        const xmlUrl = href.startsWith("http")
          ? href
          : href.startsWith("/")
          ? `${EDGAR_BASE}${href}`
          : `${dirBase}/${href.split("/").pop()}`;

        const xmlRes = await secFetch(xmlUrl);
        if (xmlRes.ok) return xmlRes.text();
      }
    }
  } catch {
    // fall through
  }

  // 2) Fallback: try the most common standalone filename
  try {
    const r = await secFetch(`${dirBase}/form4.xml`);
    if (r.ok) return r.text();
  } catch {
    // skip
  }

  return null;
}

// ─── Step 3: Parse Form 4 XML into Purchase records ──────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

function coerceArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function numVal(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "object" && v !== null && "value" in v) return Number((v as { value: unknown }).value) || 0;
  return Number(v) || 0;
}

function strVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "value" in v) return String((v as { value: unknown }).value).trim();
  return String(v).trim();
}

function parseForm4(xml: string, accNo: string, filingDate: string): Purchase[] {
  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const od = doc?.ownershipDocument as Record<string, unknown> | undefined;
  if (!od) return [];

  const issuer = od.issuer as Record<string, unknown> | undefined;
  const companyName = String(issuer?.issuerName ?? "").trim();
  const ticker = String(issuer?.issuerTradingSymbol ?? "").trim().toUpperCase();

  const cik = cikFromAccession(accNo);
  const flat = accNo.replace(/-/g, "");
  const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${flat}/${accNo}-index.htm`;

  const purchases: Purchase[] = [];

  for (const owner of coerceArray(od.reportingOwner as unknown)) {
    const ownerObj = owner as Record<string, unknown>;
    const rel = ownerObj.reportingOwnerRelationship as Record<string, unknown> | undefined;
    const isDirector = numVal(rel?.isDirector) === 1;
    const isOfficer = numVal(rel?.isOfficer) === 1;

    // Only executives (officers) and board members (directors)
    if (!isDirector && !isOfficer) continue;

    const id = ownerObj.reportingOwnerId as Record<string, unknown> | undefined;
    const insiderName = String(id?.rptOwnerName ?? "Unknown").trim();
    const title = String(rel?.officerTitle ?? (isDirector ? "Director" : "Officer")).trim();

    const ndTable = od.nonDerivativeTable as Record<string, unknown> | undefined;
    for (const txn of coerceArray(ndTable?.nonDerivativeTransaction as unknown)) {
      const t = txn as Record<string, unknown>;
      const coding = t.transactionCoding as Record<string, unknown> | undefined;
      const amounts = t.transactionAmounts as Record<string, unknown> | undefined;

      const code = strVal(coding?.transactionCode);
      const acqDisp = strVal((amounts?.transactionAcquiredDisposedCode as Record<string, unknown> | undefined));

      // P = Open-market purchase; A = acquired (not disposed)
      if (code !== "P" || acqDisp !== "A") continue;

      const shares = numVal((amounts?.transactionShares as Record<string, unknown> | undefined));
      const price = numVal((amounts?.transactionPricePerShare as Record<string, unknown> | undefined));
      const totalValue = shares * price;

      if (shares <= 0 || price <= 0 || totalValue < MIN_PURCHASE_USD) continue;

      const txDate = strVal((t.transactionDate as Record<string, unknown> | undefined)) || filingDate;

      purchases.push({
        insiderName,
        title,
        isDirector,
        isOfficer,
        companyName,
        ticker,
        shares,
        pricePerShare: price,
        totalValue,
        transactionDate: txDate,
        filingDate,
        filingUrl,
      });
    }
  }

  return purchases;
}

// ─── Step 4: Format and send Slack message ───────────────────────────────────

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function shortDate(d: string): string {
  const dt = new Date(`${d}T12:00:00Z`);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function buildSlackBlocks(purchases: Purchase[]): object[] {
  const totalValue = purchases.reduce((s, p) => s + p.totalValue, 0);
  const shown = purchases.slice(0, TOP_N_IN_SLACK);

  const header = `🔔 *Insider Purchases >$${(MIN_PURCHASE_USD / 1000).toFixed(0)}K — Past 24 Hours*\n${purchases.length} trade${purchases.length === 1 ? "" : "s"} · ${money(totalValue)} total`;

  const rows = shown.map((p, i) => {
    const badge = p.isDirector && p.isOfficer ? "Director & Officer" : p.isDirector ? "Director" : p.title || "Officer";
    const tickerStr = p.ticker ? ` *(${p.ticker})*` : "";
    return (
      `*${i + 1}.* ${p.insiderName} _[${badge}]_ — ${p.companyName}${tickerStr}\n` +
      `   ${p.shares.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)} = *${money(p.totalValue)}*  •  📅 ${shortDate(p.transactionDate)}  •  <${p.filingUrl}|SEC Filing>`
    );
  });

  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: "SEC Insider Purchase Alert", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: header } },
    { type: "divider" },
    ...rows.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
  ];

  if (purchases.length > TOP_N_IN_SLACK) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_…and ${purchases.length - TOP_N_IN_SLACK} more purchases not shown_` }],
    });
  }

  return blocks;
}

async function sendSlack(blocks: object[]): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("\n⚠️  SLACK_WEBHOOK_URL not set — printing payload to stdout:\n");
    console.log(JSON.stringify({ blocks }, null, 2));
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
  }
  console.log("✅ Summary sent to Slack.");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  console.log(`\n🔍 SEC EDGAR Insider Purchase Scanner`);
  console.log(`   Window : last 24 hours (since ${since.toISOString()})`);
  console.log(`   Filter : open-market purchases > ${money(MIN_PURCHASE_USD)} by executives/directors`);

  // 1. Get filing list
  const rawFilings = await fetchRecentForm4s(since);
  if (!rawFilings.length) {
    console.log("No Form 4 filings found in the window.");
    return;
  }

  // 2. Fetch + parse each filing
  console.log(`\n📄 Parsing ${rawFilings.length} filings (this takes ~${Math.ceil((rawFilings.length * DELAY_MS * 2) / 60_000)} min)…`);
  const purchases: Purchase[] = [];
  let done = 0;

  for (const filing of rawFilings) {
    const cik = cikFromAccession(filing.accessionNumber);
    const xml = await fetchFilingXml(cik, filing.accessionNumber);
    if (xml) {
      purchases.push(...parseForm4(xml, filing.accessionNumber, filing.filingDate));
    }
    done++;
    if (done % 20 === 0 || done === rawFilings.length) {
      process.stdout.write(`  ${done}/${rawFilings.length} parsed, ${purchases.length} qualifying purchases so far…\r`);
    }
  }
  process.stdout.write("\n");

  // 3. Filter + sort by value descending
  const qualifying = purchases
    .filter((p) => p.totalValue >= MIN_PURCHASE_USD)
    .sort((a, b) => b.totalValue - a.totalValue);

  console.log(`\n📊 Results: ${qualifying.length} insider purchases > ${money(MIN_PURCHASE_USD)}`);

  if (!qualifying.length) {
    console.log("  No qualifying purchases found. Sending empty summary to Slack.");
    await sendSlack([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔔 *Insider Purchases >$${(MIN_PURCHASE_USD / 1000).toFixed(0)}K — Past 24 Hours*\n_No qualifying open-market purchases found._`,
        },
      },
    ]);
    return;
  }

  // 4. Print top 10 to console
  console.log("\n  Top purchases:");
  qualifying.slice(0, 10).forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.insiderName} (${p.title}) — ${p.companyName} (${p.ticker}): ${money(p.totalValue)}`);
  });

  // 5. Send to Slack
  const blocks = buildSlackBlocks(qualifying);
  await sendSlack(blocks);
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
