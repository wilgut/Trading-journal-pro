/**
 * SEC EDGAR Form 4 fetcher and parser.
 *
 * EDGAR rate-limit: ≤10 req/s per IP. We stay well under that with
 * concurrency-limited batching and a 150ms inter-request pause.
 *
 * NOTE: EDGAR blocks many cloud/datacenter IP ranges with HTTP 403.
 * Run from a residential or corporate network for reliable access.
 */

const EDGAR_EFTS = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";

const EDGAR_HEADERS: HeadersInit = {
  "User-Agent": "TradingJournalPro admin@tradingjournalpro.com",
  Accept: "application/json",
  "Accept-Encoding": "gzip, deflate",
};

const MIN_VALUE_USD = 100_000;
const BATCH_CONCURRENCY = 5;
const INTER_REQUEST_MS = 150;

export interface InsiderPurchase {
  company: string;
  ticker?: string;
  cik: string;
  accession: string;
  fileDate: string;
  insiderName: string;
  title: string;
  isDirector: boolean;
  isOfficer: boolean;
  security: string;
  txnDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  edgarUrl: string;
}

// ── EDGAR search ──────────────────────────────────────────────────────────────

interface EftsFiling {
  _id: string;
  _source: {
    entity_name?: string;
    file_date?: string;
    period_of_report?: string;
  };
}

async function searchForm4Filings(
  startDt: string,
  endDt: string
): Promise<EftsFiling[]> {
  const results: EftsFiling[] = [];
  let from = 0;
  const size = 100;

  while (true) {
    const url =
      `${EDGAR_EFTS}?forms=4` +
      `&dateRange=custom&startdt=${startDt}&enddt=${endDt}` +
      `&from=${from}&size=${size}`;

    const res = await fetch(url, { headers: EDGAR_HEADERS });
    if (!res.ok) throw new Error(`EDGAR search ${res.status}: ${res.statusText}`);

    const data = await res.json();
    const hits: EftsFiling[] = data?.hits?.hits ?? [];
    if (hits.length === 0) break;

    results.push(...hits);

    const totalRaw = data?.hits?.total;
    const total =
      typeof totalRaw === "object" ? (totalRaw?.value ?? 0) : (totalRaw ?? 0);

    if (from + size >= Number(total)) break;
    from += size;
    await sleep(INTER_REQUEST_MS);
  }

  return results;
}

// ── Filing XML fetch ──────────────────────────────────────────────────────────

async function fetchFilingXml(
  accession: string,
  cik: string
): Promise<string | null> {
  const clean = accession.replace(/-/g, "");
  const cikClean = cik.replace(/^0+/, "") || "0";

  // Common primary document naming patterns
  const candidates = [
    `${EDGAR_ARCHIVES}/${cikClean}/${clean}/${accession}.xml`,
    `${EDGAR_ARCHIVES}/${cikClean}/${clean}/form4.xml`,
    `${EDGAR_ARCHIVES}/${cikClean}/${clean}/wf-form4.xml`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: EDGAR_HEADERS });
      if (res.ok) return await res.text();
    } catch {
      // try next candidate
    }
  }

  // Fallback: read the filing index to discover the XML filename
  try {
    const idxUrl = `${EDGAR_ARCHIVES}/${cikClean}/${clean}/${accession}-index.json`;
    const idxRes = await fetch(idxUrl, { headers: EDGAR_HEADERS });
    if (idxRes.ok) {
      const idx = await idxRes.json();
      const items: Array<{ name: string; type: string }> =
        idx?.directory?.item ?? [];
      const xmlItem = items.find(
        (i) =>
          i.name.endsWith(".xml") &&
          !i.name.toLowerCase().includes("label") &&
          !i.name.toLowerCase().includes("pre")
      );
      if (xmlItem) {
        const xmlRes = await fetch(
          `${EDGAR_ARCHIVES}/${cikClean}/${clean}/${xmlItem.name}`,
          { headers: EDGAR_HEADERS }
        );
        if (xmlRes.ok) return await xmlRes.text();
      }
    }
  } catch {
    // fallthrough
  }

  return null;
}

// ── Form 4 XML parser ─────────────────────────────────────────────────────────

function getTagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i"));
  return m?.[1]?.trim() ?? "";
}

function parseForm4(
  xml: string,
  filing: { accession: string; cik: string; entity_name: string; file_date: string }
): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = [];

  // Reporter identity
  const insiderName = getTagText(xml, "rptOwnerName");
  const isDirector = getTagText(xml, "isDirector") === "1";
  const isOfficer = getTagText(xml, "isOfficer") === "1";
  const title = getTagText(xml, "officerTitle");

  if (!isDirector && !isOfficer) return [];

  // Find all <nonDerivativeTransaction> blocks
  const txnPattern =
    /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m: RegExpExecArray | null;

  while ((m = txnPattern.exec(xml)) !== null) {
    const block = m[1];
    const code = getTagText(block, "transactionCode");
    if (code !== "P") continue; // only open-market purchases

    const shares = parseFloat(getTagText(block, "transactionShares") || "0");
    const price = parseFloat(
      getTagText(block, "transactionPricePerShare") || "0"
    );
    const total = shares * price;
    if (total < MIN_VALUE_USD) continue;

    const txnDate =
      getTagText(block, "transactionDate") || filing.file_date;
    const security = getTagText(block, "securityTitle") || "Common Stock";

    purchases.push({
      company: filing.entity_name,
      cik: filing.cik,
      accession: filing.accession,
      fileDate: filing.file_date,
      insiderName,
      title: title || (isDirector ? "Director" : "Officer"),
      isDirector,
      isOfficer,
      security,
      txnDate,
      shares,
      pricePerShare: price,
      totalValue: total,
      edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${filing.cik}&type=4`,
    });
  }

  return purchases;
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

async function runBatched<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      results.push(await fn(item));
      await sleep(INTER_REQUEST_MS);
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ScanResult {
  purchases: InsiderPurchase[];
  filingsScanned: number;
  startDt: string;
  endDt: string;
  generatedAt: string;
}

export async function scanInsiderPurchases(
  lookbackHours = 24
): Promise<ScanResult> {
  const now = new Date();
  const start = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const startDt = start.toISOString().slice(0, 10);
  const endDt = now.toISOString().slice(0, 10);

  const filings = await searchForm4Filings(startDt, endDt);

  const allPurchases: InsiderPurchase[] = [];

  await runBatched(
    filings,
    async (f) => {
      const cik = f._id.split("-")[0].replace(/^0+/, "") || "0";
      const xml = await fetchFilingXml(f._id, cik);
      if (!xml) return;
      const txns = parseForm4(xml, {
        accession: f._id,
        cik,
        entity_name: f._source.entity_name ?? "",
        file_date: f._source.file_date ?? "",
      });
      allPurchases.push(...txns);
    },
    BATCH_CONCURRENCY
  );

  allPurchases.sort((a, b) => b.totalValue - a.totalValue);

  return {
    purchases: allPurchases,
    filingsScanned: filings.length,
    startDt,
    endDt,
    generatedAt: now.toISOString(),
  };
}

// ── Slack message formatter ───────────────────────────────────────────────────

export function buildSlackMessage(result: ScanResult): string {
  const { purchases, filingsScanned, startDt, endDt } = result;
  const dateStr = new Date(result.generatedAt).toUTCString().slice(0, 16);

  const header =
    `:sleuth_or_spy: _SEC Insider Purchase Alert_\n` +
    `> Open-market buys by executives & directors  |  Threshold: _>$100K_\n` +
    `> Period: _${startDt}_ → _${endDt}_  |  Form 4 filings scanned: _${filingsScanned}_`;

  if (purchases.length === 0) {
    return `${header}\n_No qualifying purchases found._`;
  }

  const medals: Record<number, string> = {
    1: ":first_place_medal:",
    2: ":second_place_medal:",
    3: ":third_place_medal:",
  };

  const rows = purchases
    .slice(0, 20)
    .map((p, i) => {
      const rank = medals[i + 1] ?? `_${i + 1}._`;
      const val = formatUSD(p.totalValue);
      const role =
        p.isOfficer && p.isDirector
          ? "[Officer & Director]"
          : p.isOfficer
          ? "[Officer]"
          : "[Director]";
      const sharesStr = p.shares.toLocaleString("en-US", {
        maximumFractionDigits: 0,
      });
      const priceStr = `$${p.pricePerShare.toFixed(2)}`;
      return (
        `${rank}  _${val}_  |  _${p.company}_ (${p.ticker ?? p.cik})\n` +
        `${p.insiderName} — _${p.title}_  ${role}\n` +
        `${sharesStr} shares @ ${priceStr}  |  <${p.edgarUrl}|SEC Filing>`
      );
    })
    .join("\n");

  const topThree = purchases
    .slice(0, 3)
    .map((p) => `• _${p.ticker ?? p.company}_ ${formatUSD(p.totalValue)} by ${p.insiderName}`)
    .join("\n");

  return (
    `${header}\n` +
    `_${purchases.length} significant purchases found — ranked by value:_\n` +
    `${rows}\n` +
    `${"─".repeat(37)}\n` +
    `_Top 3 by value:_\n${topThree}\n` +
    `_Generated ${dateStr}  |  Data: SEC EDGAR Form 4_`
  );
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
