/**
 * SEC EDGAR Insider Trading Scanner
 *
 * Fetches Form 4 filings from the last 24 hours, filters for open-market
 * purchases (transaction code "P") with total value > $100 000, ranks them
 * by purchase size, and POSTs a summary to a Slack webhook.
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL  – incoming webhook URL for your Slack workspace
 *
 * Optional env vars:
 *   MIN_PURCHASE_USD   – minimum purchase value in USD (default 100000)
 *   MAX_RESULTS        – max rows in the Slack summary (default 20)
 *   LOOKBACK_HOURS     – hours to look back (default 24)
 *
 * Run:
 *   npx ts-node --esm scripts/insider-trading-scan.ts
 *
 * The SEC EDGAR API requires this User-Agent format and rate-limits to
 * 10 requests/second: https://www.sec.gov/developer
 */

import { subHours, format } from "date-fns";

// ── config ────────────────────────────────────────────────────────────────────

const USER_AGENT = "TradingJournalPro admin@tradingjournalpro.com";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";
const MIN_PURCHASE_USD = Number(process.env.MIN_PURCHASE_USD ?? 100_000);
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 20);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? 24);

// EDGAR rate-limit: ≤10 req/s per their fair-use policy
const EDGAR_DELAY_MS = 120;

// ── types ─────────────────────────────────────────────────────────────────────

interface EdgarSearchHit {
  _id: string;
  _source: {
    entity_name: string;
    file_date: string;
    period_of_report: string;
    accession_no: string;
  };
}

interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  transactionDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  filingUrl: string;
  cik: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function edgarFetch(url: string): Promise<Response> {
  await sleep(EDGAR_DELAY_MS);
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "gzip, deflate",
      Accept: "application/json, application/xml, text/html, */*",
    },
  });
}

function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].replace(/<[^>]*>/g, "").trim() : "";
}

function parseMoney(raw: string): number {
  return parseFloat(raw.replace(/[^0-9.\-]/g, "")) || 0;
}

function fmtCurrency(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

// ── EDGAR: search Form 4 filings ──────────────────────────────────────────────

async function searchForm4Filings(
  startDate: string,
  endDate: string
): Promise<EdgarSearchHit[]> {
  const hits: EdgarSearchHit[] = [];
  let from = 0;
  const pageSize = 50;

  while (true) {
    const url =
      `https://efts.sec.gov/LATEST/search-index` +
      `?q=%22transactionCode%3EP%22` + // full-text match for >transactionCode>P<
      `&forms=4` +
      `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
      `&from=${from}&size=${pageSize}`;

    const res = await edgarFetch(url);
    if (!res.ok) {
      throw new Error(
        `EDGAR search failed (${res.status}): ${await res.text()}`
      );
    }

    const data = (await res.json()) as {
      hits: { hits: EdgarSearchHit[]; total: { value: number } };
    };

    const page = data.hits?.hits ?? [];
    hits.push(...page);

    const total = data.hits?.total?.value ?? 0;
    from += page.length;
    if (from >= total || page.length === 0) break;
  }

  return hits;
}

// ── EDGAR: fetch and parse a Form 4 XML document ─────────────────────────────

async function parseFiling(hit: EdgarSearchHit): Promise<InsiderPurchase[]> {
  const accNo = hit._source.accession_no; // e.g. "0001234567-26-000001"
  const accNoClean = accNo.replace(/-/g, ""); // "000123456726000001"
  const cikRaw = accNo.split("-")[0]; // "0001234567"
  const cikInt = parseInt(cikRaw, 10).toString(); // "1234567"

  // Try both common file-name patterns for the primary Form 4 XML document.
  const baseUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoClean}`;
  const candidates = [
    `${baseUrl}/wk-form4_${accNoClean}.xml`,
    `${baseUrl}/form4.xml`,
    `${baseUrl}/${accNo}.xml`,
  ];

  // Fall back to parsing the filing index to find the .xml file.
  let xmlText_ = "";
  for (const url of candidates) {
    const r = await edgarFetch(url);
    if (r.ok) {
      xmlText_ = await r.text();
      if (xmlText_.includes("<ownershipDocument")) break;
      xmlText_ = "";
    }
  }

  if (!xmlText_) {
    const idxRes = await edgarFetch(`${baseUrl}/${accNo}-index.htm`);
    if (idxRes.ok) {
      const idxHtml = await idxRes.text();
      const xmlHref = idxHtml.match(/href="([^"]+\.xml)"/i)?.[1];
      if (xmlHref) {
        const xmlUrl = xmlHref.startsWith("http")
          ? xmlHref
          : `https://www.sec.gov${xmlHref}`;
        const r = await edgarFetch(xmlUrl);
        if (r.ok) xmlText_ = await r.text();
      }
    }
  }

  if (!xmlText_) return [];

  // ── parse metadata ──────────────────────────────────────────────────────────
  const companyName =
    xmlText(xmlText_, "issuerName") || hit._source.entity_name;
  const ticker = xmlText(xmlText_, "issuerTradingSymbol").toUpperCase();
  const insiderName = xmlText(xmlText_, "rptOwnerName");

  const isDirector = xmlText(xmlText_, "isDirector") === "1";
  const isOfficer = xmlText(xmlText_, "isOfficer") === "1";
  const officerTitle = xmlText(xmlText_, "officerTitle");
  const insiderTitle = officerTitle
    ? officerTitle
    : isDirector && isOfficer
    ? "Director / Officer"
    : isDirector
    ? "Director"
    : isOfficer
    ? "Officer"
    : "Insider";

  const filingUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikInt}&type=4&dateb=&owner=include&count=1&search_text=`;

  // ── parse non-derivative transactions ──────────────────────────────────────
  const purchases: InsiderPurchase[] = [];
  const txBlockRe =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let match: RegExpExecArray | null;

  while ((match = txBlockRe.exec(xmlText_)) !== null) {
    const block = match[1];

    const code = xmlText(block, "transactionCode");
    if (code !== "P") continue; // only open-market purchases

    const acqDisp = xmlText(block, "transactionAcquiredDisposedCode");
    if (acqDisp && acqDisp !== "A") continue; // must be "Acquired"

    const transDate = xmlText(block, "transactionDate");
    const sharesRaw = xmlText(block, "transactionShares");
    const priceRaw = xmlText(block, "transactionPricePerShare");

    const shares = parseMoney(sharesRaw);
    const price = parseMoney(priceRaw);
    const total = shares * price;

    if (total < MIN_PURCHASE_USD) continue;

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      transactionDate: transDate || hit._source.period_of_report,
      shares,
      pricePerShare: price,
      totalValue: total,
      filingUrl,
      cik: cikInt,
    });
  }

  return purchases;
}

// ── Slack message builder ─────────────────────────────────────────────────────

function buildSlackPayload(purchases: InsiderPurchase[], scanDate: string): object {
  const totalPurchased = purchases.reduce((s, p) => s + p.totalValue, 0);

  if (purchases.length === 0) {
    return {
      text: `*SEC Insider Buys >$${(MIN_PURCHASE_USD / 1000).toFixed(0)}K — ${scanDate}*\n\nNo qualifying purchases found in the last ${LOOKBACK_HOURS}h.`,
    };
  }

  const sorted = [...purchases].sort((a, b) => b.totalValue - a.totalValue);
  const top = sorted.slice(0, MAX_RESULTS);

  const medals = ["🥇", "🥈", "🥉"];
  const rows = top.map((p, i) => {
    const rank = medals[i] ?? `${i + 1}.`;
    const label = p.ticker ? `${p.ticker}` : p.companyName;
    return (
      `${rank} *${label}* — *${fmtCurrency(p.totalValue)}*\n` +
      `   ${p.insiderName} _(${p.insiderTitle})_ bought ${p.shares.toLocaleString()} sh @ $${p.pricePerShare.toFixed(2)}\n` +
      `   :calendar: ${p.transactionDate}  •  <${p.filingUrl}|SEC Filing>`
    );
  });

  const header =
    `*:bar_chart: SEC EDGAR — Insider Purchases >$${(MIN_PURCHASE_USD / 1000).toFixed(0)}K*\n` +
    `${scanDate}  •  last ${LOOKBACK_HOURS}h  •  ${purchases.length} filing(s)  •  total ${fmtCurrency(totalPurchased)}\n\n`;

  return {
    text: header + rows.join("\n\n"),
  };
}

// ── Slack sender ──────────────────────────────────────────────────────────────

async function postToSlack(payload: object): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("SLACK_WEBHOOK_URL not set — printing to stdout:\n");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook error ${res.status}: ${body}`);
  }
  console.log("Slack message sent.");
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = new Date();
  const since = subHours(now, LOOKBACK_HOURS);
  const startDate = format(since, "yyyy-MM-dd");
  const endDate = format(now, "yyyy-MM-dd");
  const scanDate = format(now, "MMM d, yyyy HH:mm 'UTC'");

  console.log(`Scanning EDGAR Form 4 filings from ${startDate} to ${endDate} …`);

  const hits = await searchForm4Filings(startDate, endDate);
  console.log(`Found ${hits.length} Form 4 hits. Fetching and parsing …`);

  const allPurchases: InsiderPurchase[] = [];

  for (const hit of hits) {
    try {
      const purchases = await parseFiling(hit);
      allPurchases.push(...purchases);
    } catch (err) {
      console.warn(`Skipping ${hit._source.accession_no}: ${err}`);
    }
  }

  console.log(
    `${allPurchases.length} purchases >${fmtCurrency(MIN_PURCHASE_USD)} found.`
  );

  const payload = buildSlackPayload(allPurchases, scanDate);
  await postToSlack(payload);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
