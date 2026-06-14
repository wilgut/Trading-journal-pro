/**
 * SEC EDGAR Insider Buy Scanner
 *
 * Fetches Form 4 filings from the last 24 hours, filters for officer/director
 * purchases > $100 K, ranks by total value, and posts a summary to Slack.
 *
 * Usage:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... npx tsx scripts/insider-buys.ts
 *
 * Required env var:
 *   SLACK_WEBHOOK_URL  — Slack Incoming Webhook URL
 *
 * Optional env vars:
 *   MIN_PURCHASE_USD   — Minimum purchase value in USD (default: 100000)
 *   MAX_FILINGS        — Max Form 4 filings to inspect per run (default: 200)
 *   LOOKBACK_HOURS     — Hours to look back from now (default: 24)
 */

const EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const USER_AGENT = "TradingJournalPro wilgut@tradingjournal.app";

const MIN_PURCHASE_USD = Number(process.env.MIN_PURCHASE_USD ?? 100_000);
const MAX_FILINGS = Number(process.env.MAX_FILINGS ?? 200);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? 24);

// ─── Types ────────────────────────────────────────────────────────────────────

interface FilingMeta {
  accessionNo: string;
  cik: string; // reporter (filer) CIK, derived from accession number
}

interface InsiderPurchase {
  issuerName: string;
  ticker: string;
  insiderName: string;
  title: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingUrl: string;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Extracts the value of an XML tag. Handles both direct content and
 * the SEC Form 4 pattern where values live in a nested <value> child.
 */
function getTagValue(xml: string, tag: string): string {
  const outer = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  );
  if (!outer) return "";
  const inner = outer[1];
  // nested <value> pattern used for numeric / date fields in Form 4
  const nested = inner.match(/<value[^>]*>\s*([^<\s][^<]*?)\s*<\/value>/i);
  if (nested) return nested[1].trim();
  // plain text content (some string fields)
  return inner.replace(/<[^>]+>/g, "").trim();
}

/** Extracts all blocks matching a repeating XML tag. */
function getAllBlocks(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) results.push(m[1]);
  return results;
}

function parseCIK(accessionNo: string): string {
  // Accession format: XXXXXXXXXX-YY-NNNNNN
  // First segment is the 10-digit CIK of the filer (reporting person for Form 4)
  const cikPadded = accessionNo.split("-")[0] ?? "0";
  return String(parseInt(cikPadded, 10));
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function commas(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ─── EDGAR fetch helpers ───────────────────────────────────────────────────────

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

// ─── EDGAR Form 4 search ──────────────────────────────────────────────────────

async function searchForm4(
  startDate: string,
  endDate: string,
  from = 0
): Promise<{ total: number; filings: FilingMeta[] }> {
  const url =
    `${EDGAR_SEARCH}?forms=4&dateRange=custom` +
    `&startdt=${startDate}&enddt=${endDate}&from=${from}`;

  const data = await fetchJSON<{
    hits: {
      total: { value: number };
      hits: Array<{ _source: { accession_no?: string } }>;
    };
  }>(url);

  if (!data) return { total: 0, filings: [] };

  const total = data.hits?.total?.value ?? 0;
  const filings: FilingMeta[] = (data.hits?.hits ?? [])
    .map((h) => {
      const accessionNo = h._source?.accession_no ?? "";
      return { accessionNo, cik: parseCIK(accessionNo) };
    })
    .filter((f) => f.accessionNo && f.cik !== "0");

  return { total, filings };
}

// ─── Fetch Form 4 XML content ─────────────────────────────────────────────────

/**
 * Returns the raw XML content of the primary Form 4 document,
 * by first reading the filing's text index to discover the filename.
 */
async function fetchForm4XML(
  cik: string,
  accessionNo: string
): Promise<string | null> {
  const noDash = accessionNo.replace(/-/g, "");
  const base = `${EDGAR_ARCHIVES}/${cik}/${noDash}`;

  // The text index lists document filenames
  const indexText = await fetchText(`${base}/${accessionNo}-index.txt`);
  if (!indexText) return null;

  const xmlFilename = extractXMLFilename(indexText);
  if (!xmlFilename) return null;

  return fetchText(`${base}/${xmlFilename}`);
}

/**
 * Parses an EDGAR filing text index to find the Form 4 XML filename.
 * Prefers the document with <TYPE>4 (or 4/A), falls back to any .xml.
 */
function extractXMLFilename(indexText: string): string | null {
  const docBlocks = indexText.split("<DOCUMENT>").slice(1);
  for (const block of docBlocks) {
    const typeMatch = block.match(/<TYPE>([^\n\r<]+)/);
    const type = typeMatch?.[1]?.trim() ?? "";
    if (type === "4" || type === "4/A") {
      const fnMatch = block.match(/<FILENAME>([^\n\r<]+)/);
      const fn = fnMatch?.[1]?.trim();
      if (fn) return fn;
    }
  }
  // Fallback: any XML file in the index
  const fallback = indexText.match(/<FILENAME>([^\n\r<]+\.xml)/i);
  return fallback?.[1]?.trim() ?? null;
}

// ─── Parse Form 4 XML for insider purchases ───────────────────────────────────

function parseForm4Purchases(xml: string, accessionNo: string): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = [];

  // Issuer (company being reported)
  const issuerBlock =
    xml.match(/<issuer>([\s\S]*?)<\/issuer>/i)?.[1] ?? "";
  const issuerName = getTagValue(issuerBlock, "issuerName");
  const ticker = getTagValue(issuerBlock, "issuerTradingSymbol").toUpperCase();

  // Reporting owner (the insider)
  const ownerBlock =
    xml.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/i)?.[1] ?? "";
  const insiderName = getTagValue(ownerBlock, "rptOwnerName");

  const relBlock =
    ownerBlock.match(
      /<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/i
    )?.[1] ?? "";
  const isOfficer = getTagValue(relBlock, "isOfficer") === "1";
  const isDirector = getTagValue(relBlock, "isDirector") === "1";

  // Only care about officers and directors
  if (!isOfficer && !isDirector) return purchases;

  const rawTitle = getTagValue(relBlock, "officerTitle");
  const title = rawTitle || (isDirector ? "Director" : "Officer");

  const cik = parseCIK(accessionNo);
  const noDash = accessionNo.replace(/-/g, "");
  const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${noDash}/${accessionNo}-index.htm`;

  // Non-derivative transactions (direct stock purchases)
  const ndTable =
    xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/i)?.[1] ?? "";
  const txns = getAllBlocks(ndTable, "nonDerivativeTransaction");

  for (const txn of txns) {
    // Must be a purchase (code P)
    const codingBlock =
      txn.match(/<transactionCoding>([\s\S]*?)<\/transactionCoding>/i)?.[1] ?? "";
    if (getTagValue(codingBlock, "transactionCode") !== "P") continue;

    // Must be an acquisition (A), not a disposal (D)
    const amtBlock =
      txn.match(/<transactionAmounts>([\s\S]*?)<\/transactionAmounts>/i)?.[1] ?? "";
    if (getTagValue(amtBlock, "transactionAcquiredDisposedCode") !== "A") continue;

    const shares = parseFloat(getTagValue(amtBlock, "transactionShares") || "0");
    const price = parseFloat(
      getTagValue(amtBlock, "transactionPricePerShare") || "0"
    );

    // Skip if data is missing or price is $0 (gifts, transfers, etc.)
    if (!shares || !price) continue;

    const totalValue = shares * price;
    if (totalValue < MIN_PURCHASE_USD) continue;

    const transactionDate = getTagValue(
      txn.match(/<transactionDate>([\s\S]*?)<\/transactionDate>/i)?.[1] ?? "",
      "value"
    );

    purchases.push({
      issuerName,
      ticker,
      insiderName,
      title,
      shares,
      pricePerShare: price,
      totalValue,
      transactionDate,
      filingUrl,
    });
  }

  return purchases;
}

// ─── Slack notification ───────────────────────────────────────────────────────

async function sendSlack(
  purchases: InsiderPurchase[],
  reportDate: string,
  scanned: number
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error(
      "⚠️  SLACK_WEBHOOK_URL not set — skipping Slack notification"
    );
    return;
  }

  const top = purchases.slice(0, 15);
  const totalFound = purchases.length;
  const header = `🏦 Insider Buys >${formatUSD(MIN_PURCHASE_USD)} — ${reportDate}`;

  let body: object;

  if (totalFound === 0) {
    body = {
      text: header,
      blocks: [
        { type: "header", text: { type: "plain_text", text: header } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `No qualifying purchases found in the last ${LOOKBACK_HOURS} h (${scanned} Form 4 filings scanned).`,
          },
        },
      ],
    };
  } else {
    const rows = top.map((p, i) => {
      const rank = `*${i + 1}.* `;
      const symbol = p.ticker ? `*${p.ticker}*` : `*${p.issuerName}*`;
      return {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `${rank}${symbol}  —  ${formatUSD(p.totalValue)}\n` +
            `›  *${p.insiderName}* (${p.title})\n` +
            `›  ${commas(p.shares)} shares @ $${p.pricePerShare.toFixed(2)}` +
            (p.issuerName ? `  |  ${p.issuerName}` : "") +
            `\n›  Date: ${p.transactionDate}  |  <${p.filingUrl}|SEC Filing ↗>`,
        },
      };
    });

    body = {
      text: `${header} — ${totalFound} found`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: header } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `Found *${totalFound}* purchase${totalFound !== 1 ? "s" : ""} ` +
              `across ${scanned} filings scanned. ` +
              `Showing top ${top.length} by value:`,
          },
        },
        { type: "divider" },
        ...rows,
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Source: SEC EDGAR Form 4 | Officers & directors only | Min ${formatUSD(MIN_PURCHASE_USD)} | ${reportDate}`,
            },
          ],
        },
      ],
    };
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Slack send failed [${res.status}]: ${text}`);
  } else {
    console.log(`✅  Slack notification sent (${totalFound} purchases).`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const startDate = isoDate(since);
  const endDate = isoDate(now);

  console.log(
    `\n🔍  Scanning SEC EDGAR Form 4 filings from ${startDate} to ${endDate}…\n`
  );

  // ── 1. Collect filing metadata ──────────────────────────────────────────────
  const { total, filings: firstPage } = await searchForm4(startDate, endDate);
  console.log(`   Total Form 4 filings on EDGAR: ${total}`);

  const allFilings: FilingMeta[] = [...firstPage];
  const cap = Math.min(total, MAX_FILINGS);

  // Paginate (EDGAR returns 10 per page)
  for (let from = 10; from < cap; from += 10) {
    await sleep(150);
    const { filings } = await searchForm4(startDate, endDate, from);
    allFilings.push(...filings);
  }

  console.log(`   Will inspect ${allFilings.length} filings (cap: ${MAX_FILINGS})\n`);

  // ── 2. Fetch & parse each filing ────────────────────────────────────────────
  const allPurchases: InsiderPurchase[] = [];
  let processed = 0;

  for (const filing of allFilings) {
    // Polite rate-limiting: stay well under EDGAR's 10 req/s ceiling
    await sleep(120);

    const xml = await fetchForm4XML(filing.cik, filing.accessionNo);
    processed++;

    if (xml) {
      const buys = parseForm4Purchases(xml, filing.accessionNo);
      allPurchases.push(...buys);
    }

    if (processed % 20 === 0 || processed === allFilings.length) {
      process.stdout.write(
        `\r   Progress: ${processed}/${allFilings.length} filings | ` +
          `Qualifying purchases so far: ${allPurchases.length}   `
      );
    }
  }

  process.stdout.write("\n\n");

  // ── 3. Sort by total value descending ───────────────────────────────────────
  allPurchases.sort((a, b) => b.totalValue - a.totalValue);

  // ── 4. Print summary to console ─────────────────────────────────────────────
  if (allPurchases.length === 0) {
    console.log(
      `   No insider purchases > ${formatUSD(MIN_PURCHASE_USD)} found.\n`
    );
  } else {
    console.log(
      `   Top insider purchases > ${formatUSD(MIN_PURCHASE_USD)}:\n`
    );
    const display = allPurchases.slice(0, 15);
    display.forEach((p, i) => {
      console.log(
        `   ${String(i + 1).padStart(2)}. ${(p.ticker || p.issuerName).padEnd(6)}  ` +
          `${formatUSD(p.totalValue).padStart(10)}  ` +
          `${p.insiderName} (${p.title})`
      );
    });
    console.log();
  }

  // ── 5. Send to Slack ─────────────────────────────────────────────────────────
  await sendSlack(allPurchases, endDate, processed);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
