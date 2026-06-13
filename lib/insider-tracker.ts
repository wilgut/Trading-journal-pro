/**
 * SEC EDGAR insider purchase tracker.
 *
 * Fetches Form 4 filings for the last 24 hours, extracts open-market stock
 * purchases (transaction code "P", acquired "A") from the non-derivative table,
 * filters for deals > $100 K, ranks by total value, and posts a Block-Kit
 * message to Slack via an incoming webhook.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const EFTS_API = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_BASE = 'https://www.sec.gov';
const USER_AGENT = 'TradingJournalPro/1.0 (contact: WILFRED.GUTIERREZ@gmail.com)';

export const MIN_PURCHASE_VALUE = 100_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FilingMeta {
  accessionNo: string;
  entityName: string;
  fileDate: string;
  filerCik: string;
}

export interface InsiderPurchase {
  insiderName: string;
  role: string;
  companyName: string;
  ticker: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  accessionNo: string;
  edgarUrl: string;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Extract filer CIK from accession number (first 10 digits, no leading zeros). */
export function cikFromAccession(accNo: string): string {
  return accNo.replace(/-/g, '').substring(0, 10).replace(/^0+/, '');
}

export function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the text value of an XML element.
 * Handles both `<tag><value>X</value></tag>` (SEC Form 4 style) and `<tag>X</tag>`.
 */
function xmlVal(xml: string, tag: string): string | null {
  const nested = xml.match(new RegExp(`<${tag}>[^]*?<value>([^<]+)</value>`, 'i'));
  if (nested) return nested[1].trim();
  const simple = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i'));
  return simple ? simple[1].trim() : null;
}

/** Extract all occurrences of `<tag>…</tag>` as substrings. */
function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

// ─── EDGAR fetchers ───────────────────────────────────────────────────────────

/**
 * Page through the EDGAR EFTS search API and return all Form 4 filing
 * metadata within the given date range (up to `maxFilings`).
 */
export async function fetchRecentForm4Filings(
  startDate: string,
  endDate: string,
  maxFilings = 500,
): Promise<FilingMeta[]> {
  const filings: FilingMeta[] = [];
  let from = 0;

  while (filings.length < maxFilings) {
    const url =
      `${EFTS_API}?q=&forms=4&dateRange=custom` +
      `&startdt=${startDate}&enddt=${endDate}&from=${from}`;

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      throw new Error(`EDGAR EFTS API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      hits?: { total?: { value?: number }; hits?: Array<{ _id?: string; _source?: Record<string, string> }> };
    };

    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) break;

    for (const h of hits) {
      const src = h._source ?? {};
      const accNo: string = src['accession_no'] ?? h._id ?? '';
      if (!accNo) continue;
      filings.push({
        accessionNo: accNo,
        entityName: src['entity_name'] ?? '',
        fileDate: src['file_date'] ?? '',
        filerCik: cikFromAccession(accNo),
      });
    }

    const total = data.hits?.total?.value ?? 0;
    from += hits.length;
    if (from >= total) break;

    await sleep(120); // stay well under EDGAR's 10 req/s limit
  }

  return filings;
}

/**
 * Fetch the Form 4 XML for a filing.
 * Tries the filing index JSON first to locate the primary document, then
 * falls back to the complete submission text file.
 */
export async function fetchForm4Xml(cik: string, accNo: string): Promise<string | null> {
  const noD = accNo.replace(/-/g, '');

  // ① Try filing index JSON → primary document path
  try {
    const idxUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${noD}/${accNo}-index.json`;
    const idxRes = await fetch(idxUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (idxRes.ok) {
      const idx = (await idxRes.json()) as { primaryDocument?: string };
      const primary = idx.primaryDocument;
      if (primary) {
        const xmlRes = await fetch(
          `${EDGAR_BASE}/Archives/edgar/data/${cik}/${noD}/${primary}`,
          { headers: { 'User-Agent': USER_AGENT } },
        );
        if (xmlRes.ok) return xmlRes.text();
      }
    }
  } catch {
    // fall through to text file approach
  }

  // ② Fallback: complete submission text file, extract embedded XML
  try {
    const txtUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${noD}/${accNo}.txt`;
    const txtRes = await fetch(txtUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!txtRes.ok) return null;
    const txt = await txtRes.text();
    const m = txt.match(/<ownershipDocument[\s\S]*?<\/ownershipDocument>/i);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// ─── Form 4 parser ────────────────────────────────────────────────────────────

/**
 * Parse open-market purchases from a Form 4 XML string.
 * Only Table I (nonDerivativeTransaction) entries with:
 *   - transactionCode = "P"  (open-market or private purchase)
 *   - acquiredDisposedCode = "A"  (acquired, not disposed)
 */
export function parseForm4(xml: string, meta: FilingMeta): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = [];

  const companyName = xmlVal(xml, 'issuerName') ?? meta.entityName;
  const ticker = xmlVal(xml, 'issuerTradingSymbol') ?? '';
  const insiderName = xmlVal(xml, 'rptOwnerName') ?? 'Unknown';

  const isDirector = xmlVal(xml, 'isDirector') === '1';
  const isOfficer = xmlVal(xml, 'isOfficer') === '1';
  const officerTitle = xmlVal(xml, 'officerTitle');

  let role = 'Insider';
  if (isOfficer && officerTitle) role = officerTitle;
  else if (isDirector && isOfficer) role = `Director / ${officerTitle ?? 'Officer'}`;
  else if (isDirector) role = 'Director';
  else if (isOfficer) role = 'Officer';

  const noD = meta.accessionNo.replace(/-/g, '');
  const edgarUrl =
    `${EDGAR_BASE}/Archives/edgar/data/${meta.filerCik}/${noD}/${meta.accessionNo}-index.htm`;

  for (const blk of xmlBlocks(xml, 'nonDerivativeTransaction')) {
    const code = xmlVal(blk, 'transactionCode');
    const direction = xmlVal(blk, 'transactionAcquiredDisposedCode');
    if (code !== 'P' || direction !== 'A') continue;

    const shares = parseFloat(xmlVal(blk, 'transactionShares') ?? '0');
    const price = parseFloat(xmlVal(blk, 'transactionPricePerShare') ?? '0');
    const txDate = xmlVal(blk, 'transactionDate') ?? '';

    if (shares <= 0 || price <= 0) continue;

    purchases.push({
      insiderName,
      role,
      companyName,
      ticker,
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      transactionDate: txDate,
      accessionNo: meta.accessionNo,
      edgarUrl,
    });
  }

  return purchases;
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface TrackerStats {
  filingsFound: number;
  filingsProcessed: number;
  purchasesOver100k: number;
  totalValue: number;
}

/**
 * Full pipeline: fetch filings → parse XML → filter & rank.
 * Returns the filtered, sorted list and populates `stats`.
 */
export async function gatherInsiderPurchases(
  startDate: string,
  endDate: string,
  opts: {
    maxFilings?: number;
    batchSize?: number;
    onProgress?: (msg: string) => void;
    stats?: TrackerStats;
  } = {},
): Promise<InsiderPurchase[]> {
  const { maxFilings = 500, batchSize = 5, onProgress, stats } = opts;

  onProgress?.(`Fetching Form 4 filings from ${startDate} to ${endDate}…`);
  const filings = await fetchRecentForm4Filings(startDate, endDate, maxFilings);
  onProgress?.(`Found ${filings.length} filings — parsing XML…`);

  if (stats) {
    stats.filingsFound = filings.length;
    stats.filingsProcessed = 0;
  }

  const allPurchases: InsiderPurchase[] = [];

  for (let i = 0; i < filings.length; i += batchSize) {
    const batch = filings.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const xml = await fetchForm4Xml(f.filerCik, f.accessionNo);
        return xml ? parseForm4(xml, f) : [];
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') allPurchases.push(...r.value);
    }

    if (stats) stats.filingsProcessed = Math.min(i + batchSize, filings.length);

    if (i + batchSize < filings.length) await sleep(120);

    if ((i + batchSize) % 50 === 0) {
      onProgress?.(
        `  Processed ${Math.min(i + batchSize, filings.length)}/${filings.length} filings, ` +
          `${allPurchases.length} purchases so far…`,
      );
    }
  }

  const filtered = allPurchases
    .filter((p) => p.totalValue >= MIN_PURCHASE_VALUE)
    .sort((a, b) => b.totalValue - a.totalValue);

  if (stats) {
    stats.purchasesOver100k = filtered.length;
    stats.totalValue = filtered.reduce((s, p) => s + p.totalValue, 0);
  }

  return filtered;
}

// ─── Slack formatting ─────────────────────────────────────────────────────────

export function buildSlackPayload(purchases: InsiderPurchase[], dateRange: string): object {
  const totalValue = purchases.reduce((s, p) => s + p.totalValue, 0);
  const top = purchases.slice(0, 20);

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📈 SEC Insider Purchases — Last 24 Hours', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Period:* ${dateRange}   |   ` +
          `*Purchases > $100K:* ${purchases.length}   |   ` +
          `*Total Value:* ${formatCurrency(totalValue)}`,
      },
    },
    { type: 'divider' },
  ];

  top.forEach((p, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `*${rank}.*`;
    const sharesStr = p.shares.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const dateStr = p.transactionDate
      ? new Date(`${p.transactionDate}T12:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'N/A';

    const tickerBadge = p.ticker ? ` (*${p.ticker}*)` : '';

    const block: Record<string, unknown> = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${medal} ${p.companyName}${tickerBadge}`,
          `👤 ${p.insiderName}  _(${p.role})_`,
          `💰 ${formatCurrency(p.totalValue)}  ·  ${sharesStr} shares @ $${p.pricePerShare.toFixed(2)}  ·  ${dateStr}`,
        ].join('\n'),
      },
    };

    if (p.edgarUrl) {
      block['accessory'] = {
        type: 'button',
        text: { type: 'plain_text', text: 'SEC Filing', emoji: false },
        url: p.edgarUrl,
        action_id: `sec_${rank}`,
      };
    }

    blocks.push(block);
  });

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Source: SEC EDGAR Form 4 filings · Generated ${new Date().toUTCString()}_`,
        },
      ],
    },
  );

  return { blocks };
}

export function buildEmptySlackPayload(dateRange: string): object {
  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📈 SEC Insider Purchases — Last 24 Hours', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Period:* ${dateRange}\n\n_No open-market purchases over $100K found in this period._`,
        },
      },
    ],
  };
}

// ─── Slack sender ─────────────────────────────────────────────────────────────

export async function sendSlackMessage(payload: object): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL environment variable is not set');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook error ${res.status}: ${body}`);
  }
}
