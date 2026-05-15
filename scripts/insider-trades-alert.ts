#!/usr/bin/env tsx
/**
 * SEC EDGAR Form 4 Insider Purchase Alert
 *
 * Scans Form 4 filings filed in the last 24 hours, filters for open-market
 * purchases above $100K, ranks them by total value, and sends the summary
 * to a Slack channel.
 *
 * Required env vars (at least one Slack option):
 *   SLACK_WEBHOOK_URL   — Incoming Webhook URL (simplest)
 *   SLACK_BOT_TOKEN     — Bot token (requires SLACK_CHANNEL too)
 *   SLACK_CHANNEL       — e.g. "#insider-alerts" (used with bot token)
 */

import { XMLParser } from 'fast-xml-parser';

// ─── Constants ───────────────────────────────────────────────────────────────

const EDGAR_EFTS_URL = 'https://efts.sec.gov/LATEST/search-index';
const SEC_BASE_URL = 'https://www.sec.gov';
const MIN_PURCHASE_VALUE = 100_000;
const MAX_FILINGS_TO_PROCESS = 500;
const REQUEST_DELAY_MS = 120; // ≈ 8 req/s, safely under EDGAR's 10 req/s cap
const USER_AGENT = 'TradingJournalPro insider-alert/1.0 contact@tradingjournalpro.com';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FilingRef {
  accessionNo: string;
  cik: string;
  entityName: string;
}

interface InsiderTrade {
  insiderName: string;
  insiderTitle: string;
  companyName: string;
  ticker: string;
  sharesAcquired: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  filingUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatCurrency(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

/** Pull the scalar value from `<tag><value>X</value></tag>` or plain `<tag>X</tag>`. */
function xmlVal(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const v = (node as Record<string, unknown>).value;
    if (v !== undefined) return xmlVal(v);
  }
  return '';
}

function xmlNum(node: unknown): number {
  return parseFloat(xmlVal(node)) || 0;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

async function fetchOk(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return res;
    if (res.status === 429) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    if (attempt === retries - 1) throw new Error(`HTTP ${res.status} — ${url}`);
    await sleep(500);
  }
  throw new Error(`Exhausted retries for ${url}`);
}

// ─── EDGAR: list recent Form 4 filings ───────────────────────────────────────

async function listRecentForm4Filings(
  startDate: string,
  endDate: string,
): Promise<FilingRef[]> {
  const refs: FilingRef[] = [];
  let from = 0;
  const pageSize = 100;

  while (refs.length < MAX_FILINGS_TO_PROCESS) {
    const url = new URL(EDGAR_EFTS_URL);
    url.searchParams.set('q', '');
    url.searchParams.set('forms', '4,4/A');
    url.searchParams.set('dateRange', 'custom');
    url.searchParams.set('startdt', startDate);
    url.searchParams.set('enddt', endDate);
    url.searchParams.set('from', String(from));

    const res = await fetchOk(url.toString());
    const body = await res.json() as {
      hits?: { hits?: Array<{ _id: string; _source?: Record<string, string> }> };
    };

    const hits = body?.hits?.hits ?? [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      const src = hit._source ?? {};
      const accessionNo: string = src['accession_no'] ?? hit._id ?? '';
      const cik: string = src['entity_id'] ?? '';
      const entityName: string = src['entity_name'] ?? '';
      if (accessionNo && cik) refs.push({ accessionNo, cik, entityName });
    }

    if (hits.length < pageSize) break;
    from += pageSize;
    await sleep(REQUEST_DELAY_MS);
  }

  return refs;
}

// ─── EDGAR: resolve XML document URL from filing index ───────────────────────

async function resolveXmlUrl(cik: string, accessionNo: string): Promise<string | null> {
  const flat = accessionNo.replace(/-/g, '');
  const indexUrl = `${SEC_BASE_URL}/Archives/edgar/data/${cik}/${flat}/${accessionNo}-index.json`;

  try {
    const res = await fetchOk(indexUrl);
    const data = await res.json() as {
      directory?: { item?: Array<{ name: string; type: string }> };
    };
    const items = toArray(data?.directory?.item);

    // Prefer the document typed as "4" with an .xml extension
    const primary = items.find(i => i.type === '4' && i.name.endsWith('.xml'));
    const fallback = items.find(i => i.name.endsWith('.xml'));
    const chosen = primary ?? fallback;

    return chosen
      ? `${SEC_BASE_URL}/Archives/edgar/data/${cik}/${flat}/${chosen.name}`
      : null;
  } catch {
    return null;
  }
}

// ─── EDGAR: parse Form 4 XML → insider trades ────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  parseAttributeValue: true,
});

async function parseForm4(xmlUrl: string, filingUrl: string): Promise<InsiderTrade[]> {
  try {
    const res = await fetchOk(xmlUrl);
    const raw = await res.text();
    const doc = xmlParser.parse(raw) as Record<string, unknown>;
    const root = (doc['ownershipDocument'] ?? {}) as Record<string, unknown>;

    if (!root) return [];

    const issuer = (root['issuer'] ?? {}) as Record<string, unknown>;
    const companyName = xmlVal(issuer['issuerName']);
    const ticker = xmlVal(issuer['issuerTradingSymbol']);

    const ownerBlock = (root['reportingOwner'] ?? {}) as Record<string, unknown>;
    const ownerId = (ownerBlock['reportingOwnerId'] ?? {}) as Record<string, unknown>;
    const ownerRel = (ownerBlock['reportingOwnerRelationship'] ?? {}) as Record<string, unknown>;

    const insiderName = xmlVal(ownerId['rptOwnerName']) || 'Unknown';
    const insiderTitle = (() => {
      const isOfficer = xmlVal(ownerRel['isOfficer']);
      const isDirector = xmlVal(ownerRel['isDirector']);
      if (isOfficer === '1' || isOfficer === 1 as unknown)
        return xmlVal(ownerRel['officerTitle']) || 'Officer';
      if (isDirector === '1' || isDirector === 1 as unknown) return 'Director';
      return xmlVal(ownerRel['officerTitle']) || 'Insider';
    })();

    const trades: InsiderTrade[] = [];

    // Non-derivative transactions (direct stock purchases)
    const nonDerivTable = (root['nonDerivativeTable'] ?? {}) as Record<string, unknown>;
    const txns = toArray(nonDerivTable['nonDerivativeTransaction'] as unknown);

    for (const tx of txns) {
      const txRecord = tx as Record<string, unknown>;
      const coding = (txRecord['transactionCoding'] ?? {}) as Record<string, unknown>;
      const amounts = (txRecord['transactionAmounts'] ?? {}) as Record<string, unknown>;

      const txCode = xmlVal(coding['transactionCode']);
      const adCode = xmlVal(amounts['transactionAcquiredDisposedCode']);

      // P = open market purchase; T = Rule 10b5-1 planned purchase
      // Must be acquired (A), not disposed (D)
      if ((txCode !== 'P' && txCode !== 'T') || adCode !== 'A') continue;

      const shares = xmlNum(amounts['transactionShares']);
      const price = xmlNum(amounts['transactionPricePerShare']);
      const totalValue = shares * price;

      if (shares <= 0 || price <= 0 || totalValue < MIN_PURCHASE_VALUE) continue;

      const transactionDate = xmlVal(txRecord['transactionDate']);

      trades.push({
        insiderName,
        insiderTitle,
        companyName,
        ticker,
        sharesAcquired: shares,
        pricePerShare: price,
        totalValue,
        transactionDate,
        filingUrl,
      });
    }

    return trades;
  } catch {
    return [];
  }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Merge multiple same-day purchases by the same insider in the same stock
 * into one entry (weighted-average price).
 */
function aggregateTrades(raw: InsiderTrade[]): InsiderTrade[] {
  const map = new Map<string, InsiderTrade>();

  for (const t of raw) {
    const key = `${t.insiderName}|${t.ticker || t.companyName}`;
    const existing = map.get(key);
    if (existing) {
      const newShares = existing.sharesAcquired + t.sharesAcquired;
      const newTotal = existing.totalValue + t.totalValue;
      existing.sharesAcquired = newShares;
      existing.totalValue = newTotal;
      existing.pricePerShare = newTotal / newShares;
    } else {
      map.set(key, { ...t });
    }
  }

  return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
}

// ─── Slack: send message ──────────────────────────────────────────────────────

async function sendSlack(trades: InsiderTrade[]): Promise<void> {
  const webhookUrl = process.env['SLACK_WEBHOOK_URL'];
  const botToken = process.env['SLACK_BOT_TOKEN'];
  const channel = process.env['SLACK_CHANNEL'] ?? '#insider-alerts';

  if (!webhookUrl && !botToken) {
    console.error(
      'Set SLACK_WEBHOOK_URL (Incoming Webhook) or SLACK_BOT_TOKEN + SLACK_CHANNEL.',
    );
    process.exit(1);
  }

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York',
  });

  const top = trades.slice(0, 20);

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Insider Purchases >$100K  —  ${dateLabel}`, emoji: true },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: trades.length > 0
          ? `Found *${trades.length}* qualified purchase${trades.length !== 1 ? 's' : ''} in the last 24 h · showing top ${top.length} by value`
          : '_No insider purchases above $100K filed in the last 24 hours._',
      }],
    },
    { type: 'divider' },
  ];

  const medals = ['🥇', '🥈', '🥉'];

  top.forEach((t, i) => {
    const rank = medals[i] ?? `${i + 1}.`;
    const ticker = t.ticker ? ` *(${t.ticker})*` : '';
    const filingLink = `<${t.filingUrl}|SEC filing>`;

    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `${rank}  ${t.companyName}${ticker}\n${t.insiderName} · ${t.insiderTitle}`,
        },
        {
          type: 'mrkdwn',
          text: `*${formatCurrency(t.totalValue)}*\n${t.sharesAcquired.toLocaleString()} shares @ $${t.pricePerShare.toFixed(2)} · ${filingLink}`,
        },
      ],
    });
  });

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Source: <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4>  ·  Transaction codes P (open market) and T (Rule 10b5-1 plan, acquired)`,
      }],
    },
  );

  const payload = {
    text: `Insider Purchase Alert: ${trades.length} purchase(s) >$100K in the last 24 h`,
    blocks,
  };

  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${res.statusText}`);
  } else if (botToken) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ ...payload, channel }),
    });
    const body = await res.json() as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(`Slack API error: ${body.error}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = formatDate(yesterday);
  const endDate = formatDate(now);

  console.log(`Fetching Form 4 filings from ${startDate} to ${endDate}…`);

  const filings = await listRecentForm4Filings(startDate, endDate);
  console.log(`Found ${filings.length} Form 4 filing(s) — parsing for purchases…`);

  const rawTrades: InsiderTrade[] = [];
  let idx = 0;

  for (const { accessionNo, cik } of filings) {
    idx++;
    const flat = accessionNo.replace(/-/g, '');
    const filingUrl =
      `${SEC_BASE_URL}/Archives/edgar/data/${cik}/${flat}/${accessionNo}-index.htm`;

    // Two network calls per filing: index + XML
    const xmlUrl = await resolveXmlUrl(cik, accessionNo);
    await sleep(REQUEST_DELAY_MS);

    if (xmlUrl) {
      const trades = await parseForm4(xmlUrl, filingUrl);
      rawTrades.push(...trades);
      await sleep(REQUEST_DELAY_MS);
    }

    if (idx % 50 === 0) {
      console.log(`  ${idx}/${filings.length} processed, ${rawTrades.length} qualified so far…`);
    }
  }

  const ranked = aggregateTrades(rawTrades);

  console.log(`\nTotal insider purchases >$${(MIN_PURCHASE_VALUE / 1_000).toFixed(0)}K: ${ranked.length}`);
  if (ranked.length > 0) {
    console.log('\nTop 10:');
    ranked.slice(0, 10).forEach((t, i) => {
      console.log(
        `  ${i + 1}. ${t.companyName} (${t.ticker || 'N/A'})  ${t.insiderName}  ${formatCurrency(t.totalValue)}`,
      );
    });
  }

  await sendSlack(ranked);
  console.log('\nSlack message sent.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
