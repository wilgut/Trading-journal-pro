/**
 * SEC EDGAR Insider Buying Monitor
 *
 * Fetches Form 4 filings from the previous business day, filters for
 * open-market purchases (code "P") by executives and directors worth
 * over $100 000, then posts a ranked summary to a Slack webhook.
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL   – Slack Incoming Webhook URL
 *
 * Optional env vars:
 *   TARGET_DATE         – Override date (YYYY-MM-DD). Defaults to previous business day.
 *   EDGAR_USER_AGENT    – User-Agent sent to EDGAR (required by SEC Fair Access policy).
 *                         Default: "TradingJournalPro/1.0 (your-email@example.com)"
 *   MIN_PURCHASE_VALUE  – Minimum purchase value in USD. Default: 100000
 */

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EDGAR_BASE = "https://www.sec.gov";
const EFTS_BASE = "https://efts.sec.gov/LATEST/search-index";
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 120; // ~8 req/s, under SEC's 10 req/s limit

const MIN_VALUE = Number(process.env.MIN_PURCHASE_VALUE ?? 100_000);
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ??
  "TradingJournalPro/1.0 (trading-journal-pro@example.com)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPreviousBusinessDay(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function edgarFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (res.status === 429) {
    console.warn("  Rate-limited by EDGAR, backing off 5 s…");
    await sleep(5_000);
    return edgarFetch(url);
  }
  return res;
}

/** Extract the 10-digit CIK from the first segment of an accession number. */
function cikFromAccession(accession: string): string {
  return String(parseInt(accession.split("-")[0], 10));
}

/** Convert accession number to the bare 18-digit string used in paths. */
function accessionPath(accession: string): string {
  return accession.replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// EDGAR search – returns accession numbers for the target date
// ---------------------------------------------------------------------------

async function fetchAccessionNumbers(date: string): Promise<string[]> {
  const accessions: string[] = [];
  let from = 0;

  while (true) {
    const url =
      `${EFTS_BASE}?forms=4,4%2FA` +
      `&dateRange=custom&startdt=${date}&enddt=${date}` +
      `&from=${from}&size=${PAGE_SIZE}`;

    const res = await edgarFetch(url);
    if (!res.ok) {
      console.error(`  EFTS search failed (${res.status}) at offset ${from}`);
      break;
    }

    const data = await res.json();
    const hits: any[] = data?.hits?.hits ?? [];
    if (hits.length === 0) break;

    for (const h of hits) accessions.push(h._id as string);

    const total: number = data?.hits?.total?.value ?? 0;
    from += PAGE_SIZE;
    if (from >= total) break;

    await sleep(REQUEST_DELAY_MS);
  }

  return accessions;
}

// ---------------------------------------------------------------------------
// Resolve the primary XML document URL inside a filing
// ---------------------------------------------------------------------------

async function resolveXmlUrl(
  accession: string,
  cik: string
): Promise<string | null> {
  const indexUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accessionPath(accession)}/index.json`;
  const res = await edgarFetch(indexUrl);
  if (!res.ok) return null;

  let index: any;
  try {
    index = await res.json();
  } catch {
    return null;
  }

  const items: any[] = index?.directory?.item ?? [];

  // Prefer the document typed as "4" or "4/A"; fall back to any .xml that
  // isn't the full submission text file or index itself.
  const primary =
    items.find((i) => i.type === "4" || i.type === "4/A") ??
    items.find(
      (i) =>
        typeof i.name === "string" &&
        i.name.endsWith(".xml") &&
        !i.name.endsWith("-index.htm") &&
        i.name !== `${accessionPath(accession)}.txt`
    );

  if (!primary) return null;
  return `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accessionPath(accession)}/${primary.name}`;
}

// ---------------------------------------------------------------------------
// Parse a Form 4 XML and return qualifying purchases
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

function num(v: any): number {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function parseForm4Xml(
  xml: string,
  filingUrl: string
): InsiderPurchase[] {
  let doc: any;
  try {
    doc = xmlParser.parse(xml)?.ownershipDocument;
  } catch {
    return [];
  }
  if (!doc) return [];

  const issuer = doc.issuer ?? {};
  const rawOwner = doc.reportingOwner;

  // Normalise to array (some filings have multiple owners)
  const owners: any[] = Array.isArray(rawOwner)
    ? rawOwner
    : rawOwner
    ? [rawOwner]
    : [];

  const purchases: InsiderPurchase[] = [];

  for (const owner of owners) {
    const rel = owner?.reportingOwnerRelationship ?? {};
    const isDirector =
      String(rel.isDirector) === "1" || rel.isDirector === true;
    const isOfficer =
      String(rel.isOfficer) === "1" || rel.isOfficer === true;

    // Only executives and directors
    if (!isDirector && !isOfficer) continue;

    const insiderName: string =
      owner?.reportingOwnerId?.rptOwnerName ?? "Unknown";
    const officerTitle: string = rel.officerTitle ?? "";
    const insiderTitle =
      officerTitle || (isDirector ? "Director" : "Officer");

    const rawTxns = doc.nonDerivativeTable?.nonDerivativeTransaction;
    if (!rawTxns) continue;

    const txns: any[] = Array.isArray(rawTxns) ? rawTxns : [rawTxns];

    for (const txn of txns) {
      if (!txn) continue;
      const code: string = txn?.transactionCoding?.transactionCode ?? "";
      if (code !== "P") continue; // open-market purchase only

      const shares = num(txn?.transactionAmounts?.transactionShares?.value);
      const price = num(
        txn?.transactionAmounts?.transactionPricePerShare?.value
      );
      const totalValue = shares * price;

      if (totalValue < MIN_VALUE) continue;

      purchases.push({
        companyName: String(issuer.issuerName ?? "Unknown"),
        ticker: String(issuer.issuerTradingSymbol ?? "N/A").toUpperCase(),
        insiderName,
        insiderTitle,
        shares,
        pricePerShare: price,
        totalValue,
        transactionDate: String(txn?.transactionDate?.value ?? ""),
        filingUrl,
      });
    }
  }

  return purchases;
}

// ---------------------------------------------------------------------------
// Slack message formatter (Block Kit)
// ---------------------------------------------------------------------------

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function buildSlackPayload(
  purchases: InsiderPurchase[],
  date: string
): object {
  const sorted = [...purchases].sort((a, b) => b.totalValue - a.totalValue);
  const top = sorted.slice(0, 20);
  const totalBought = purchases.reduce((s, p) => s + p.totalValue, 0);

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `SEC Insider Buying — ${date}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Qualifying purchases (>${ fmtMoney(MIN_VALUE)})*\n${purchases.length}`,
        },
        {
          type: "mrkdwn",
          text: `*Total capital deployed*\n${fmtMoney(totalBought)}`,
        },
      ],
    },
    { type: "divider" },
  ];

  if (top.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_No insider purchases above ${fmtMoney(MIN_VALUE)} found for this date._`,
      },
    });
  } else {
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const rank = i + 1;
      const medal =
        rank === 1 ? ":first_place_medal:" :
        rank === 2 ? ":second_place_medal:" :
        rank === 3 ? ":third_place_medal:" :
        `*${rank}.*`;

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `${medal}  *${p.companyName}* (${p.ticker})  •  *${fmtMoney(p.totalValue)}*`,
            `>  :bust_in_silhouette: ${p.insiderName}  _${p.insiderTitle}_`,
            `>  :shopping_trolley: ${fmtNum(p.shares)} shares @ $${p.pricePerShare.toFixed(2)}`,
            `>  :calendar: ${p.transactionDate}`,
          ].join("\n"),
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Filing", emoji: true },
          url: p.filingUrl,
        },
      });
    }

    if (sorted.length > 20) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_… and ${sorted.length - 20} more purchases not shown._`,
          },
        ],
      });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          `Source: <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=include|SEC EDGAR Form 4>` +
          `  •  Executives & Directors only  •  Purchases >${ fmtMoney(MIN_VALUE)} only`,
      },
    ],
  });

  return {
    text: `Insider Buying (${date}): ${purchases.length} purchases totalling ${fmtMoney(totalBought)}`,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Send to Slack
// ---------------------------------------------------------------------------

async function sendToSlack(payload: object): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("SLACK_WEBHOOK_URL is not set");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook returned ${res.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== SEC EDGAR Insider Buying Monitor ===");

  const targetDate = process.env.TARGET_DATE ?? getPreviousBusinessDay();
  console.log(`Target date : ${targetDate}`);
  console.log(`Min value   : ${fmtMoney(MIN_VALUE)}`);

  // 1. Get all Form 4 accession numbers for the date
  console.log("\n[1/3] Fetching Form 4 filing list from EDGAR…");
  const accessions = await fetchAccessionNumbers(targetDate);
  console.log(`      Found ${accessions.length} Form 4 filings`);

  // 2. Fetch and parse each filing
  console.log("\n[2/3] Parsing filings…");
  const allPurchases: InsiderPurchase[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const acc of accessions) {
    const cik = cikFromAccession(acc);
    const filingUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accessionPath(acc)}/`;

    await sleep(REQUEST_DELAY_MS);

    const xmlUrl = await resolveXmlUrl(acc, cik);
    if (!xmlUrl) { skipped++; continue; }

    await sleep(REQUEST_DELAY_MS);

    const xmlRes = await edgarFetch(xmlUrl);
    if (!xmlRes.ok) { skipped++; continue; }

    const xml = await xmlRes.text();
    const purchases = parseForm4Xml(xml, filingUrl);
    allPurchases.push(...purchases);
    parsed++;

    if (parsed % 50 === 0) {
      console.log(
        `      … ${parsed}/${accessions.length} parsed, ${allPurchases.length} qualifying so far`
      );
    }
  }

  console.log(
    `      Done. Parsed: ${parsed}, skipped: ${skipped}, qualifying purchases: ${allPurchases.length}`
  );

  // 3. Send to Slack
  console.log("\n[3/3] Sending summary to Slack…");
  const payload = buildSlackPayload(allPurchases, targetDate);
  await sendToSlack(payload);
  console.log("      Sent successfully.\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
