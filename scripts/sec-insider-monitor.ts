#!/usr/bin/env ts-node
/**
 * SEC EDGAR Insider Purchase Monitor
 *
 * Scans all Form 4 filings from the last 24 hours for open-market stock purchases
 * by executives and directors, filters for transactions ≥$100 000, ranks by total
 * value, and posts a formatted summary to a Slack channel.
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL   – Slack Incoming Webhook URL  (required for Slack posting)
 *   SLACK_CHANNEL_ID    – Slack channel ID            (used if SLACK_BOT_TOKEN is set)
 *   SLACK_BOT_TOKEN     – Slack bot OAuth token       (alternative to webhook)
 *   SEC_USER_AGENT      – "Company email@domain.com"  (EDGAR policy; has a default)
 *   MIN_PURCHASE_USD    – Minimum purchase threshold  (default: 100000)
 *   HOURS_LOOKBACK      – Hours to look back          (default: 24)
 *
 * Usage:
 *   npx ts-node scripts/sec-insider-monitor.ts
 *   # or after compiling:
 *   node dist/scripts/sec-insider-monitor.js
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InsiderPurchase {
  companyName: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string;
  relationship: string;
  transactionDate: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  filingDate: string;
  cik: string;
  accessionNo: string;
  secUrl: string;
}

interface EdgarHit {
  _id: string;
  _source: {
    period_of_report?: string;
    file_date?: string;
    entity_name?: string;
    form_type?: string;
    accession_no?: string;
    cik?: string;
  };
}

interface EdgarSearchResponse {
  hits: {
    total: { value: number; relation: string };
    hits: EdgarHit[];
  };
}

interface FilingIndexEntry {
  name: string;
  type: string;
  size: string;
  'last-modified': string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const USER_AGENT =
  process.env.SEC_USER_AGENT ?? 'TradingJournalPro research@tradingjournal.pro';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? '#insider-alerts';
const MIN_PURCHASE_USD = parseInt(process.env.MIN_PURCHASE_USD ?? '100000', 10);
const HOURS_LOOKBACK = parseInt(process.env.HOURS_LOOKBACK ?? '24', 10);
const PAGE_SIZE = 50;          // EDGAR results per page
const MAX_PAGES = 6;           // cap at 300 filings to avoid timeout
const REQUEST_DELAY_MS = 120;  // polite delay between EDGAR calls (ms)
const TOP_N_SLACK = 25;        // rows shown in Slack table

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client: typeof https | typeof http = url.startsWith('https')
      ? https
      : http;

    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/xml, text/html, */*',
          ...extraHeaders,
        },
      },
      (res) => {
        // follow one redirect
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          resolve(httpGet(res.headers.location, extraHeaders));
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', reject);
    req.setTimeout(25_000, () => {
      req.destroy(new Error(`Timeout: ${url}`));
    });
  });
}

async function httpPost(
  url: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': USER_AGENT,
        ...extraHeaders,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => {
        data += c.toString();
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getDateRange(hoursBack: number): { startdt: string; enddt: string } {
  const now = new Date();
  const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
  const fmt = (d: Date): string => d.toISOString().split('T')[0];
  return { startdt: fmt(start), enddt: fmt(now) };
}

// ─── EDGAR – filing list ──────────────────────────────────────────────────────

async function fetchFilingPage(
  startdt: string,
  enddt: string,
  from: number,
): Promise<EdgarSearchResponse> {
  const url =
    `https://efts.sec.gov/LATEST/search-index` +
    `?forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}` +
    `&from=${from}&size=${PAGE_SIZE}`;
  const raw = await httpGet(url);
  return JSON.parse(raw) as EdgarSearchResponse;
}

async function fetchAllForm4Filings(
  startdt: string,
  enddt: string,
): Promise<EdgarHit[]> {
  const allHits: EdgarHit[] = [];
  let from = 0;
  let page = 0;

  while (page < MAX_PAGES) {
    const data = await fetchFilingPage(startdt, enddt, from);
    const hits = data.hits?.hits ?? [];
    allHits.push(...hits);

    const total = data.hits?.total?.value ?? 0;
    from += hits.length;
    page++;

    if (from >= total || hits.length === 0) break;
    if (page < MAX_PAGES) await sleep(REQUEST_DELAY_MS);
  }

  return allHits;
}

// ─── EDGAR – XML resolution ───────────────────────────────────────────────────

async function resolveXmlUrl(
  cik: string,
  accessionNo: string,
): Promise<string | null> {
  const noDashes = accessionNo.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${noDashes}`;

  // Try the filing index JSON first (most reliable)
  try {
    const indexJson = await httpGet(`${base}/index.json`);
    const index = JSON.parse(indexJson) as {
      directory?: { item?: FilingIndexEntry[] };
    };
    const items: FilingIndexEntry[] = index?.directory?.item ?? [];

    // Prefer the primary Form 4 XML document
    const xmlFile =
      items.find(
        (f) =>
          f.name.endsWith('.xml') &&
          (f.type === '4' ||
            f.name.toLowerCase().includes('form4') ||
            f.name.toLowerCase().includes('ownership')),
      ) ?? items.find((f) => f.name.endsWith('.xml'));

    if (xmlFile) return `${base}/${xmlFile.name}`;
  } catch {
    // index.json not available – fall through to convention-based guesses
  }

  // Convention 1: accession-formatted.xml
  for (const candidate of [
    `${base}/${accessionNo}.xml`,
    `${base}/form4.xml`,
    `${base}/xslForm4X01.xml`,
  ]) {
    try {
      const head = await httpGet(candidate);
      if (head.includes('<ownershipDocument') || head.includes('<XML>')) {
        return candidate;
      }
    } catch {
      // try next
    }
  }

  return null;
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return m?.[1]?.trim() ?? '';
}

function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

function parseForm4(
  xml: string,
  filingDate: string,
  cik: string,
  accessionNo: string,
): InsiderPurchase[] {
  const purchases: InsiderPurchase[] = [];

  // Issuer (company)
  const issuer = xml.match(/<issuer>([\s\S]*?)<\/issuer>/i)?.[1] ?? '';
  const companyName =
    xmlTag(issuer, 'issuerName') || xmlTag(xml, 'issuerName') || 'Unknown';
  const ticker =
    xmlTag(issuer, 'issuerTradingSymbol') ||
    xmlTag(xml, 'issuerTradingSymbol') ||
    'N/A';

  // Reporting owner(s)
  const ownerBlocks = xmlBlocks(xml, 'reportingOwner');
  const names: string[] = [];
  const titles: string[] = [];
  const rels: string[] = [];

  for (const ob of ownerBlocks) {
    const name = xmlTag(ob, 'rptOwnerName');
    if (name) names.push(name);

    const relBlock =
      ob.match(
        /<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/i,
      )?.[1] ?? '';
    const isDir = /true|1/i.test(xmlTag(relBlock, 'isDirector'));
    const isOff = /true|1/i.test(xmlTag(relBlock, 'isOfficer'));
    const is10 = /true|1/i.test(xmlTag(relBlock, 'isTenPercentOwner'));
    const title = xmlTag(relBlock, 'officerTitle');

    let rel: string;
    if (isDir && isOff) rel = 'Dir & Officer';
    else if (isDir) rel = 'Director';
    else if (isOff) rel = title || 'Officer';
    else if (is10) rel = '10% Owner';
    else rel = title || 'Insider';

    rels.push(rel);
    titles.push(title || rel);
  }

  const insiderName = names.join(' / ') || 'Unknown';
  const insiderTitle = titles.join(' / ') || 'Unknown';
  const relationship = rels.join(' / ') || 'Unknown';

  const secUrl =
    `https://www.sec.gov/cgi-bin/browse-edgar` +
    `?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=1`;

  // Helper to emit a purchase if it passes the threshold
  const tryAdd = (txn: string): void => {
    const code = xmlTag(txn, 'transactionCode');
    const acqDisp = xmlTag(txn, 'transactionAcquiredDisposedCode');
    if (code !== 'P' || acqDisp !== 'A') return;

    const txnDate = xmlTag(txn, 'transactionDate') || filingDate;
    const shares = parseFloat(xmlTag(txn, 'transactionShares'));
    const price = parseFloat(xmlTag(txn, 'transactionPricePerShare'));
    if (!shares || !price || isNaN(shares) || isNaN(price)) return;

    const totalValue = shares * price;
    if (totalValue < MIN_PURCHASE_USD) return;

    purchases.push({
      companyName,
      ticker,
      insiderName,
      insiderTitle,
      relationship,
      transactionDate: txnDate,
      shares,
      pricePerShare: price,
      totalValue,
      filingDate,
      cik,
      accessionNo,
      secUrl,
    });
  };

  // Non-derivative transactions (common stock open-market buys)
  const nonDerivSection =
    xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/i)?.[1] ??
    '';
  xmlBlocks(nonDerivSection, 'nonDerivativeTransaction').forEach(tryAdd);

  // Derivative transactions (options/warrants purchased at market – rare)
  const derivSection =
    xml.match(/<derivativeTable>([\s\S]*?)<\/derivativeTable>/i)?.[1] ?? '';
  xmlBlocks(derivSection, 'derivativeTransaction').forEach(tryAdd);

  return purchases;
}

// ─── Slack formatting ─────────────────────────────────────────────────────────

function fmtMoney(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtShares(n: number): string {
  return n >= 1_000 ? n.toLocaleString('en-US') : n.toString();
}

function buildSlackMessage(
  purchases: InsiderPurchase[],
  startdt: string,
  enddt: string,
  totalFilings: number,
): string {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const threshold = fmtMoney(MIN_PURCHASE_USD);

  if (purchases.length === 0) {
    return (
      `*:bar_chart: SEC Insider Purchase Monitor* | _${ts}_\n` +
      `>Scanned *${totalFilings}* Form 4 filings (${startdt} → ${enddt})\n` +
      `_No executive/director open-market purchases ≥${threshold} detected in the last ${HOURS_LOOKBACK} hours._`
    );
  }

  const top = purchases.slice(0, TOP_N_SLACK);

  // Header block
  const header =
    `*:moneybag: SEC Insider Purchases — Last ${HOURS_LOOKBACK} Hours* | _${ts}_\n` +
    `>*${purchases.length}* qualifying purchase${purchases.length > 1 ? 's' : ''} ` +
    `≥${threshold} · ranked by total value · source: ` +
    `<https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|EDGAR Form 4>\n` +
    `>Scanned *${totalFilings}* filings (${startdt} → ${enddt})\n`;

  // Table
  const rows = top.map((p, i) => {
    const rank = `${i + 1}.`.padEnd(3);
    const ticker = `\`${p.ticker.padEnd(6)}\``;
    const company = p.companyName.length > 26
      ? p.companyName.slice(0, 24) + '…'
      : p.companyName;
    const insider = p.insiderName.length > 24
      ? p.insiderName.slice(0, 22) + '…'
      : p.insiderName;
    const role = p.relationship.length > 18
      ? p.relationship.slice(0, 16) + '…'
      : p.relationship;
    const shares = fmtShares(p.shares);
    const price = `$${p.pricePerShare.toFixed(2)}`;
    const total = `*${fmtMoney(p.totalValue)}*`;
    const link = `<${p.secUrl}|SEC>`;

    return `${rank} ${ticker} ${company.padEnd(27)} ${insider.padEnd(25)} ${role.padEnd(19)} ${shares.padStart(10)} @ ${price.padStart(8)}  →  ${total.padStart(12)}  ${link}`;
  });

  const tableHeader =
    `\`\`\`\n` +
    `#   Ticker Company                     Insider                   Role                Shares      Price        Total        \n` +
    `─── ────── ─────────────────────────── ───────────────────────── ─────────────────── ────────── ─────── ──────────────\n` +
    rows.join('\n') +
    `\n\`\`\``;

  const footer =
    purchases.length > TOP_N_SLACK
      ? `\n_…and ${purchases.length - TOP_N_SLACK} more purchases not shown. Run the script directly for the full CSV._`
      : '';

  return header + '\n' + tableHeader + footer;
}

// ─── Slack delivery ───────────────────────────────────────────────────────────

async function postToSlack(message: string): Promise<void> {
  // Option A: Incoming Webhook
  if (SLACK_WEBHOOK_URL) {
    await httpPost(SLACK_WEBHOOK_URL, JSON.stringify({ text: message, mrkdwn: true }));
    console.log('[sec-insider-monitor] Posted to Slack via webhook.');
    return;
  }

  // Option B: Web API with bot token
  if (SLACK_BOT_TOKEN && SLACK_CHANNEL_ID) {
    const body = JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
    });
    await httpPost(
      'https://slack.com/api/chat.postMessage',
      body,
      { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    );
    console.log('[sec-insider-monitor] Posted to Slack via Web API.');
    return;
  }

  // Fallback: print to stdout
  console.log('\n══════════════════════════ SLACK OUTPUT ══════════════════════════');
  console.log(message);
  console.log('══════════════════════════════════════════════════════════════════\n');
  console.warn(
    '[sec-insider-monitor] Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN+SLACK_CHANNEL_ID to post to Slack.',
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();
  console.log(`[sec-insider-monitor] Starting — ${new Date().toISOString()}`);

  const { startdt, enddt } = getDateRange(HOURS_LOOKBACK);
  console.log(`[sec-insider-monitor] Scanning Form 4 filings: ${startdt} → ${enddt}`);

  // 1. Fetch filing list from EDGAR full-text search
  console.log('[sec-insider-monitor] Fetching Form 4 filing list from EDGAR…');
  const filings = await fetchAllForm4Filings(startdt, enddt);
  const totalFilings = filings.length;
  console.log(`[sec-insider-monitor] ${totalFilings} filings retrieved. Parsing…`);

  // 2. Process each filing
  const allPurchases: InsiderPurchase[] = [];
  let processed = 0;
  let skipped = 0;
  let errCount = 0;

  for (const hit of filings) {
    const { cik, accession_no, file_date, entity_name } = hit._source;
    if (!cik || !accession_no) { skipped++; continue; }

    try {
      await sleep(REQUEST_DELAY_MS);
      const xmlUrl = await resolveXmlUrl(cik, accession_no);
      if (!xmlUrl) { skipped++; continue; }

      await sleep(REQUEST_DELAY_MS);
      const xml = await httpGet(xmlUrl);
      if (!xml.includes('<ownershipDocument') && !xml.includes('<XML>')) {
        skipped++;
        continue;
      }

      const purchases = parseForm4(xml, file_date ?? enddt, cik, accession_no);
      allPurchases.push(...purchases);
      processed++;

      if (purchases.length > 0) {
        console.log(
          `[sec-insider-monitor] ✓ ${entity_name ?? cik} — ` +
          `${purchases.length} purchase(s) ≥${fmtMoney(MIN_PURCHASE_USD)} found`,
        );
      }
    } catch (err) {
      errCount++;
      if (errCount <= 5) {
        console.warn(
          `[sec-insider-monitor] ✗ ${entity_name ?? cik}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if ((processed + skipped + errCount) % 25 === 0) {
      console.log(
        `[sec-insider-monitor] Progress: ${processed + skipped + errCount}/${totalFilings} ` +
        `| ${allPurchases.length} qualifying purchases so far`,
      );
    }
  }

  // 3. Filter duplicates, rank by total value
  const seen = new Set<string>();
  const ranked = allPurchases
    .filter((p) => {
      const key = `${p.cik}-${p.accessionNo}-${p.transactionDate}-${p.shares}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.totalValue - a.totalValue);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[sec-insider-monitor] Done in ${elapsed}s — ` +
    `${processed} parsed, ${skipped} skipped, ${errCount} errors, ` +
    `${ranked.length} qualifying purchases`,
  );

  // 4. Build message and post to Slack
  const message = buildSlackMessage(ranked, startdt, enddt, totalFilings);
  await postToSlack(message);
}

main().catch((err) => {
  console.error('[sec-insider-monitor] Fatal:', err);
  process.exit(1);
});
