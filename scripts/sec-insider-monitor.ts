#!/usr/bin/env tsx
/**
 * SEC EDGAR Insider Purchase Monitor
 *
 * Scans all Form 4 filings from the last 24 hours, filters for open-market
 * purchases > $100K, ranks them by total value, and posts a summary to Slack.
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL   — Slack Incoming Webhook URL
 *
 * Optional env vars:
 *   MIN_PURCHASE_VALUE  — Minimum purchase value in USD (default: 100000)
 *   LOOKBACK_HOURS      — How many hours back to scan (default: 24)
 *
 * Usage:
 *   npx tsx scripts/sec-insider-monitor.ts
 *   npm run monitor:insiders
 */

import { XMLParser } from 'fast-xml-parser';

// ── Config ───────────────────────────────────────────────────────────────────

const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_SUBMISSIONS_URL = 'https://data.sec.gov/submissions';
const EDGAR_ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data';

const MIN_PURCHASE_VALUE = parseInt(process.env.MIN_PURCHASE_VALUE ?? '100000', 10);
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS ?? '24', 10);
// SEC fair-access policy: ≤ 10 requests/second
const SEC_RATE_LIMIT_MS = 110;
const USER_AGENT = 'Trading-Journal-Pro (https://github.com/wilgut/trading-journal-pro)';

// ── Types ────────────────────────────────────────────────────────────────────

interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  sharesAcquired: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingUrl: string;
}

interface EdgarSearchHit {
  _id: string;
  _source: {
    entity_name: string;
    file_date: string;
    period_of_report: string;
    form_type: string;
    accession_no: string;
  };
}

interface EdgarSearchResponse {
  hits: {
    total: { value: number };
    hits: EdgarSearchHit[];
  };
}

interface SubmissionsRecent {
  accessionNumber: string[];
  form: string[];
  filingDate: string[];
  primaryDocument: string[];
}

interface SubmissionsData {
  filings: {
    recent: SubmissionsRecent;
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function formatCurrency(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

// First 10 digits of the accession number (without dashes) are the filer CIK.
function cikFromAccession(accessionNo: string): string {
  return accessionNo.replace(/-/g, '').substring(0, 10);
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, application/xml, text/xml, text/html, */*',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
        console.warn(`  Rate-limited — waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) await sleep(2 ** attempt * 500);
    }
  }
  throw lastError;
}

// ── EDGAR API ────────────────────────────────────────────────────────────────

async function searchForm4Filings(
  startDate: string,
  endDate: string
): Promise<EdgarSearchHit[]> {
  const allHits: EdgarSearchHit[] = [];
  let from = 0;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams({
      forms: '4',
      dateRange: 'custom',
      startdt: startDate,
      enddt: endDate,
      from: String(from),
    });

    const res = await fetchWithRetry(`${EDGAR_SEARCH_URL}?${params}`);
    const data: EdgarSearchResponse = await res.json();

    const hits = data.hits?.hits ?? [];
    allHits.push(...hits);

    const total = data.hits?.total?.value ?? 0;
    if (allHits.length >= total || hits.length < pageSize) break;

    from += pageSize;
    await sleep(SEC_RATE_LIMIT_MS);
  }

  return allHits;
}

async function getSubmissions(cik: string): Promise<SubmissionsData | null> {
  const paddedCIK = cik.padStart(10, '0');
  try {
    const res = await fetchWithRetry(`${EDGAR_SUBMISSIONS_URL}/CIK${paddedCIK}.json`);
    return res.json() as Promise<SubmissionsData>;
  } catch {
    return null;
  }
}

async function parseForm4XML(
  cik: string,
  accessionNo: string,
  primaryDoc: string
): Promise<InsiderPurchase[]> {
  const accNoDash = accessionNo.replace(/-/g, '');
  // SEC paths use numeric CIK (no leading zeros) in the directory name.
  const numericCIK = String(parseInt(cik, 10));
  const xmlUrl = `${EDGAR_ARCHIVES_URL}/${numericCIK}/${accNoDash}/${primaryDoc}`;
  const filingUrl = `${EDGAR_ARCHIVES_URL}/${numericCIK}/${accNoDash}/${accessionNo}-index.htm`;

  let xml: string;
  try {
    const res = await fetchWithRetry(xmlUrl);
    xml = await res.text();
  } catch {
    return [];
  }

  // Skip non-XML responses (some primary docs are HTML wrappers).
  if (!xml.trim().startsWith('<')) return [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    isArray: (name) =>
      ['nonDerivativeTransaction', 'derivativeTransaction', 'reportingOwner'].includes(name),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const doc = (parsed as { ownershipDocument?: Record<string, unknown> }).ownershipDocument;
  if (!doc) return [];

  const issuer = doc.issuer as Record<string, unknown> | undefined;
  const companyName = String(issuer?.issuerName ?? 'Unknown');
  const ticker = String(issuer?.issuerTradingSymbol ?? 'N/A').toUpperCase();

  const ownersRaw = doc.reportingOwner;
  const owners = Array.isArray(ownersRaw) ? ownersRaw : [ownersRaw];
  const owner = owners[0] as Record<string, unknown> | undefined;
  const ownerId = owner?.reportingOwnerId as Record<string, unknown> | undefined;
  const ownerRel = owner?.reportingOwnerRelationship as Record<string, unknown> | undefined;

  const insiderName = String(ownerId?.rptOwnerName ?? 'Unknown');
  const insiderTitle =
    String(ownerRel?.officerTitle ?? '') ||
    (ownerRel?.isDirector === '1' || ownerRel?.isDirector === 1 ? 'Director' : '') ||
    (ownerRel?.isTenPercentOwner === '1' ? '10% Owner' : 'Insider');

  const nonDerivTable = doc.nonDerivativeTable as
    | { nonDerivativeTransaction?: unknown[] }
    | undefined;
  const transactions = nonDerivTable?.nonDerivativeTransaction ?? [];
  const purchases: InsiderPurchase[] = [];

  for (const rawTx of transactions) {
    const tx = rawTx as Record<string, unknown>;
    const coding = tx.transactionCoding as Record<string, unknown> | undefined;
    const amounts = tx.transactionAmounts as Record<string, unknown> | undefined;

    const code = String(coding?.transactionCode ?? '');
    const acquiredDisposed = String(
      (amounts?.transactionAcquiredDisposedCode as Record<string, unknown> | undefined)?.value ?? ''
    );

    // Only open-market purchases (code "P") where shares are acquired (code "A").
    if (code !== 'P' || acquiredDisposed !== 'A') continue;

    const shares = parseFloat(
      String((amounts?.transactionShares as Record<string, unknown> | undefined)?.value ?? '0')
    );
    const price = parseFloat(
      String(
        (amounts?.transactionPricePerShare as Record<string, unknown> | undefined)?.value ?? '0'
      )
    );
    const totalValue = shares * price;

    if (!isFinite(totalValue) || totalValue < MIN_PURCHASE_VALUE) continue;

    const transactionDate = String(
      (tx.transactionDate as Record<string, unknown> | undefined)?.value ?? ''
    );

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      sharesAcquired: shares,
      pricePerShare: price,
      totalValue,
      transactionDate,
      filingUrl,
    });
  }

  return purchases;
}

// ── Slack ────────────────────────────────────────────────────────────────────

function buildSlackMessage(
  purchases: InsiderPurchase[],
  dateRange: { start: string; end: string }
): Record<string, unknown> {
  const totalValue = purchases.reduce((s, p) => s + p.totalValue, 0);
  const display = purchases.slice(0, 10);
  const threshold = formatCurrency(MIN_PURCHASE_VALUE);

  if (purchases.length === 0) {
    return {
      text: `No insider purchases >${threshold} found (${dateRange.start} → ${dateRange.end}).`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*SEC Insider Purchase Monitor*\n_${dateRange.start} → ${dateRange.end}_\n\nNo qualifying open-market purchases found (threshold: >${threshold}).`,
          },
        },
      ],
    };
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SEC Insider Purchases — Last 24 Hours', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Qualifying Purchases*\n${purchases.length} transactions` },
        { type: 'mrkdwn', text: `*Combined Value*\n${formatCurrency(totalValue)}` },
        { type: 'mrkdwn', text: `*Min Threshold*\n>${threshold}` },
        { type: 'mrkdwn', text: `*Period*\n${dateRange.start} → ${dateRange.end}` },
      ],
    },
    { type: 'divider' },
  ];

  const medals: Record<number, string> = { 1: ':first_place_medal:', 2: ':second_place_medal:', 3: ':third_place_medal:' };

  display.forEach((p, i) => {
    const rank = i + 1;
    const rankLabel = medals[rank] ?? `*${rank}.*`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${rankLabel}  *${p.ticker}* — ${p.companyName}`,
          `>:moneybag: *${formatCurrency(p.totalValue)}*   ${p.sharesAcquired.toLocaleString()} shares @ $${p.pricePerShare.toFixed(2)}`,
          `>:bust_in_silhouette: ${p.insiderName}  ·  ${p.insiderTitle}  ·  :calendar: ${p.transactionDate}`,
          `><${p.filingUrl}|View SEC Filing>`,
        ].join('\n'),
      },
    });
  });

  const footerNote =
    purchases.length > 10
      ? `Showing top 10 of *${purchases.length}* qualifying purchases. `
      : '';

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${footerNote}_Source: <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4> · ${new Date().toUTCString()}_`,
      },
    ],
  });

  return {
    text: `${purchases.length} insider open-market purchases >${threshold} (${dateRange.start} → ${dateRange.end})`,
    blocks,
  };
}

async function sendToSlack(message: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook error ${res.status}: ${body}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const startDate = since.toISOString().split('T')[0];
  const endDate = now.toISOString().split('T')[0];

  console.log('\n=== SEC Insider Purchase Monitor ===');
  console.log(`Lookback : ${LOOKBACK_HOURS}h  |  Threshold : >${formatCurrency(MIN_PURCHASE_VALUE)}`);
  console.log(`Period   : ${startDate} → ${endDate}\n`);

  // 1. Collect all Form 4 filings for the period
  console.log('1/4  Searching EDGAR for Form 4 filings…');
  const filings = await searchForm4Filings(startDate, endDate);
  console.log(`     Found ${filings.length} filings\n`);

  if (filings.length === 0) {
    const msg = buildSlackMessage([], { start: startDate, end: endDate });
    await sendToSlack(msg);
    console.log('No filings — empty summary sent to Slack.');
    return;
  }

  // 2. Group filings by filer CIK to batch submissions lookups
  const cikToFilings = new Map<string, string[]>();
  for (const hit of filings) {
    const acc = hit._source.accession_no;
    const cik = cikFromAccession(acc);
    (cikToFilings.get(cik) ?? cikToFilings.set(cik, []).get(cik)!).push(acc);
  }
  console.log(`2/4  Resolving primary documents for ${cikToFilings.size} unique filers…`);

  // 3. Fetch submissions JSON per filer → resolve primary doc → parse XML
  const allPurchases: InsiderPurchase[] = [];
  let filersDone = 0;
  let filingsDone = 0;

  for (const [cik, accessions] of Array.from(cikToFilings.entries())) {
    const submissions = await getSubmissions(cik);
    filersDone++;

    if (submissions) {
      const recent = submissions.filings.recent;
      // Build a lookup: accession → index in the recent arrays
      const accIndex = new Map<string, number>(
        recent.accessionNumber.map((acc, i) => [acc, i])
      );

      for (const accessionNo of accessions) {
        const idx = accIndex.get(accessionNo);
        if (idx === undefined) continue;
        if (recent.form[idx] !== '4') continue;

        const primaryDoc = recent.primaryDocument[idx];
        if (!primaryDoc) continue;

        const purchases = await parseForm4XML(cik, accessionNo, primaryDoc);
        allPurchases.push(...purchases);
        filingsDone++;

        await sleep(SEC_RATE_LIMIT_MS);
      }
    }

    await sleep(SEC_RATE_LIMIT_MS);

    if (filersDone % 25 === 0) {
      console.log(
        `     ${filersDone}/${cikToFilings.size} filers · ${filingsDone} filings parsed · ${allPurchases.length} qualifying purchases`
      );
    }
  }

  // 4. Rank by total value descending
  allPurchases.sort((a, b) => b.totalValue - a.totalValue);

  console.log(`\n3/4  Results`);
  console.log(`     Qualifying purchases (>${formatCurrency(MIN_PURCHASE_VALUE)}): ${allPurchases.length}`);

  if (allPurchases.length > 0) {
    console.log('     Top 5:');
    allPurchases.slice(0, 5).forEach((p, i) => {
      console.log(`       ${i + 1}. ${p.ticker.padEnd(6)} ${p.insiderName.padEnd(30)} ${formatCurrency(p.totalValue)}`);
    });
  }

  // 5. Send to Slack
  console.log('\n4/4  Sending summary to Slack…');
  const message = buildSlackMessage(allPurchases, { start: startDate, end: endDate });
  await sendToSlack(message);
  console.log('     Done!\n');
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
