#!/usr/bin/env node
/**
 * SEC EDGAR Insider Buy Monitor
 *
 * Fetches Form 4 filings from the last 24 hours, filters for open-market
 * purchases by officers and directors where total value exceeds $100k,
 * and posts a ranked summary to Slack.
 *
 * Required env var:
 *   SLACK_WEBHOOK_URL  — Slack incoming webhook URL
 *
 * Optional env vars:
 *   MIN_PURCHASE_USD   — minimum purchase value in USD (default: 100000)
 *   MAX_FILINGS        — max Form 4 filings to scan (default: 200)
 */

const MIN_PURCHASE_VALUE = Number(process.env.MIN_PURCHASE_USD ?? 100_000);
const MAX_FILINGS = Number(process.env.MAX_FILINGS ?? 200);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const EDGAR_EFTS = 'https://efts.us-east-1.prod.efts.aws.lcloud.com/1.0/search-index';
const EDGAR_ARCHIVE = 'https://www.sec.gov/Archives/edgar/data';
const USER_AGENT = 'TradingJournalPro/1.0 research-automation@tradingjournal.pro';

// ── helpers ─────────────────────────────────────────────────────────────────

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

async function fetchJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(attempt * 500);
    }
  }
}

async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(attempt * 500);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function xmlValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

function xmlNestedValue(block, outer, inner) {
  const outerMatch = block.match(new RegExp(`<${outer}>([\\s\\S]*?)</${outer}>`));
  if (!outerMatch) return null;
  return xmlValue(outerMatch[1], inner);
}

// ── EDGAR fetch ─────────────────────────────────────────────────────────────

async function getRecentForm4Accessions(startDate, endDate) {
  const accessions = [];
  const pageSize = 40;
  let from = 0;

  while (accessions.length < MAX_FILINGS) {
    const url =
      `${EDGAR_EFTS}?forms=4&dateRange=custom` +
      `&startdt=${startDate}&enddt=${endDate}` +
      `&hits.hits._source=accession_no,entity_name,file_date` +
      `&from=${from}&hits.hits.highlight=false`;

    const data = await fetchJson(url);
    const hits = data?.hits?.hits ?? [];
    if (hits.length === 0) break;

    for (const h of hits) {
      if (h._source?.accession_no) accessions.push(h._source.accession_no);
    }

    const total = data?.hits?.total?.value ?? 0;
    from += hits.length;
    if (from >= total) break;

    await sleep(110); // stay well under SEC's 10 req/s limit
  }

  return accessions.slice(0, MAX_FILINGS);
}

function cikFromAccession(accNo) {
  // accNo format: "0001234567-24-000001"
  return accNo.split('-')[0].replace(/^0+/, '');
}

function accNoDash(accNo) {
  return accNo.replace(/-/g, '');
}

async function findForm4XmlUrl(accNo) {
  const cik = cikFromAccession(accNo);
  const noDash = accNoDash(accNo);
  const indexUrl = `${EDGAR_ARCHIVE}/${cik}/${noDash}/`;
  const html = await fetchText(indexUrl);

  // Prefer files whose name contains "form4" or ends with .xml (but not xsd/schema)
  const links = [...html.matchAll(/href="([^"]+\.xml)"/gi)]
    .map((m) => m[1])
    .filter((f) => !/(xsd|schema)/i.test(f));

  if (links.length === 0) return null;

  const preferred = links.find((f) => /form4/i.test(f)) ?? links[0];
  // links may be relative or absolute
  return preferred.startsWith('http')
    ? preferred
    : `${EDGAR_ARCHIVE}/${cik}/${noDash}/${preferred.replace(/^\//, '')}`;
}

// ── Form 4 XML parser ────────────────────────────────────────────────────────

function parseNonDerivativePurchases(xml) {
  const purchases = [];
  const txBlocks = [
    ...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi),
  ].map((m) => m[1]);

  for (const block of txBlocks) {
    const code = xmlNestedValue(block, 'transactionCoding', 'transactionCode');
    const direction = xmlNestedValue(
      block,
      'transactionAmounts',
      'transactionAcquiredDisposedCode',
    );

    if (code !== 'P' || direction !== 'A') continue;

    const sharesRaw = xmlNestedValue(block, 'transactionAmounts', 'transactionShares');
    const priceRaw = xmlNestedValue(block, 'transactionAmounts', 'transactionPricePerShare');

    const shares = parseFloat(sharesRaw ?? '0');
    const price = parseFloat(priceRaw ?? '0');
    if (!shares || !price) continue;

    const securityTitle = xmlNestedValue(block, 'securityTitle', 'value') ?? 'Common Stock';
    const txDate = xmlNestedValue(block, 'transactionDate', 'value') ?? '';

    purchases.push({ shares, price, value: shares * price, securityTitle, txDate });
  }

  return purchases;
}

async function parseForm4Filing(accNo) {
  try {
    const xmlUrl = await findForm4XmlUrl(accNo);
    if (!xmlUrl) return null;

    const xml = await fetchText(xmlUrl);

    const isOfficer =
      /<isOfficer>(?:1|true)<\/isOfficer>/i.test(xml);
    const isDirector =
      /<isDirector>(?:1|true)<\/isDirector>/i.test(xml);

    if (!isOfficer && !isDirector) return null;

    const issuerName = xmlValue(xml, 'issuerName') ?? 'Unknown Company';
    const issuerTicker = xmlValue(xml, 'issuerTradingSymbol') ?? '';
    const reporterName = xmlValue(xml, 'rptOwnerName') ?? 'Unknown';
    const officerTitle = xmlValue(xml, 'officerTitle') ?? '';
    const role = officerTitle || (isDirector ? 'Director' : 'Officer');

    const purchases = parseNonDerivativePurchases(xml);
    const totalValue = purchases.reduce((s, p) => s + p.value, 0);

    if (totalValue < MIN_PURCHASE_VALUE) return null;

    return {
      accNo,
      issuerName,
      issuerTicker: issuerTicker.toUpperCase(),
      reporterName,
      role,
      isOfficer,
      isDirector,
      purchases,
      totalValue,
    };
  } catch {
    return null;
  }
}

// ── Slack notification ───────────────────────────────────────────────────────

function fmt(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function buildSlackBlocks(buys, startDate, endDate) {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `SEC Insider Purchases > ${fmt(MIN_PURCHASE_VALUE)} — ${startDate} to ${endDate}`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Ranked by transaction value · ${buys.length} qualifying purchase${buys.length !== 1 ? 's' : ''} · Source: SEC EDGAR Form 4`,
        },
      ],
    },
    { type: 'divider' },
  ];

  for (let i = 0; i < buys.length; i++) {
    const b = buys[i];
    const ticker = b.issuerTicker ? ` (${b.issuerTicker})` : '';
    const edgarLink = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikFromAccession(b.accNo)}&type=4&dateb=&owner=include&count=10`;
    const shareBreakdown = b.purchases
      .map((p) => `${p.shares.toLocaleString()} sh @ ${fmt(p.price)}`)
      .join(', ');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${i + 1}. <${edgarLink}|${b.issuerName}${ticker}>* — *${fmt(b.totalValue)}*\n` +
          `${b.reporterName} · _${b.role}_\n` +
          `${shareBreakdown}`,
      },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Data from <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4 filings>. Not investment advice.',
      },
    ],
  });

  return blocks;
}

async function postToSlack(buys, startDate, endDate) {
  const fallbackText =
    `SEC Insider Purchases >${fmt(MIN_PURCHASE_VALUE)} (${startDate}–${endDate}): ` +
    buys.map((b, i) => `${i + 1}. ${b.issuerName} — ${fmt(b.totalValue)}`).join(' | ');

  const payload = {
    text: fallbackText,
    blocks: buildSlackBlocks(buys, startDate, endDate),
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = dateStr(dayAgo);
  const endDate = dateStr(now);

  console.log(`[edgar-insider-buys] Scanning Form 4 filings ${startDate} → ${endDate}`);
  console.log(`[edgar-insider-buys] Filter: purchases > ${fmt(MIN_PURCHASE_VALUE)} by officers/directors`);

  const accessions = await getRecentForm4Accessions(startDate, endDate);
  console.log(`[edgar-insider-buys] Retrieved ${accessions.length} Form 4 accession numbers`);

  const buys = [];
  for (let i = 0; i < accessions.length; i++) {
    const result = await parseForm4Filing(accessions[i]);
    if (result) {
      buys.push(result);
      console.log(`  + ${result.reporterName} (${result.role}) → ${result.issuerName} ${result.issuerTicker} ${fmt(result.totalValue)}`);
    }
    // Throttle: ~5 req/s across two fetch calls per iteration
    await sleep(200);
  }

  buys.sort((a, b) => b.totalValue - a.totalValue);
  console.log(`[edgar-insider-buys] ${buys.length} qualifying purchases found`);

  if (buys.length === 0) {
    console.log('[edgar-insider-buys] Nothing to report — skipping Slack notification');
    return { sent: false, count: 0 };
  }

  if (SLACK_WEBHOOK_URL) {
    await postToSlack(buys, startDate, endDate);
    console.log('[edgar-insider-buys] Posted to Slack');
  } else {
    console.log('[edgar-insider-buys] No SLACK_WEBHOOK_URL set — printing summary:\n');
    buys.forEach((b, i) => {
      const ticker = b.issuerTicker ? ` (${b.issuerTicker})` : '';
      console.log(`  ${i + 1}. ${b.issuerName}${ticker} — ${fmt(b.totalValue)}`);
      console.log(`     ${b.reporterName} · ${b.role}`);
    });
  }

  return { sent: !!SLACK_WEBHOOK_URL, count: buys.length, buys };
}

main().catch((err) => {
  console.error('[edgar-insider-buys] Fatal error:', err);
  process.exit(1);
});
