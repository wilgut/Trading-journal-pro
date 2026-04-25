import { NextResponse } from 'next/server';

const MIN_PURCHASE_USD = 100_000;
const SEC_USER_AGENT   = 'TradingJournalPro/1.0 (dev@tradingjournal.com)';
const EDGAR_SEARCH     = 'https://efts.sec.gov';
const EDGAR_BASE       = 'https://data.sec.gov';
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? 'C0AUARBCPND';

// ─── Types ─────────────────────────────────────────────────────────────────

interface Filing {
  accessionNo: string;
  entityName: string;
  filedAt: string;
  cik: string;
}

interface InsiderPurchase {
  company: string;
  ticker: string;
  executive: string;
  role: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  transactionDate: string;
  accessionNo: string;
  cik: string;
  filingUrl: string;
}

// ─── EDGAR helpers ──────────────────────────────────────────────────────────

async function searchForm4Filings(startDate: string, endDate: string): Promise<Filing[]> {
  const url =
    `${EDGAR_SEARCH}/LATEST/search-index?q=&forms=4` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}` +
    `&hits.hits._source=entity_name,file_date,period_of_report,accession_no` +
    `&hits.hits.total.value=true`;

  const res  = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) throw new Error(`EDGAR search ${res.status}`);
  const data = await res.json();

  return (data?.hits?.hits ?? []).map((h: Record<string, unknown>) => {
    const src = h._source as Record<string, string> ?? {};
    return {
      accessionNo: src.accession_no ?? (h._id as string) ?? '',
      entityName:  src.entity_name  ?? 'Unknown',
      filedAt:     src.file_date    ?? startDate,
      cik:         ((src.accession_no ?? '') as string).split('-')[0]?.replace(/^0+/, '') ?? '',
    };
  });
}

async function parsePurchases(cik: string, accessionNo: string): Promise<InsiderPurchase[]> {
  const accNoDashes = accessionNo.replace(/-/g, '');

  let xmlFilename: string | undefined;
  try {
    const idxRes = await fetch(
      `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/index.json`,
      { headers: { 'User-Agent': SEC_USER_AGENT } }
    );
    if (idxRes.ok) {
      const idx   = await idxRes.json();
      const files = (idx?.directory?.item ?? []) as Array<{ name: string }>;
      const xml   = files.find(
        (f) => f.name.endsWith('.xml') && !f.name.includes('xbrl') && f.name !== 'primary_doc.xml'
      ) ?? files.find((f) => f.name.endsWith('.xml'));
      xmlFilename = xml?.name;
    }
  } catch { /* fall through */ }

  xmlFilename ??= `${accNoDashes}.xml`;

  const xmlRes = await fetch(
    `${EDGAR_BASE}/Archives/edgar/data/${cik}/${accNoDashes}/${xmlFilename}`,
    { headers: { 'User-Agent': SEC_USER_AGENT } }
  );
  if (!xmlRes.ok) return [];

  const xml = await xmlRes.text();
  return extractPurchases(xml, accessionNo, cik);
}

function xmlField(xml: string, tag: string): string | null {
  const m =
    xml.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]*)<\\/value>`, 'i')) ??
    xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m?.[1]?.trim() ?? null;
}

function xmlAll(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

function extractPurchases(xml: string, accessionNo: string, cik: string): InsiderPurchase[] {
  const issuerName   = xmlField(xml, 'issuerName')          ?? 'Unknown';
  const ticker       = xmlField(xml, 'issuerTradingSymbol') ?? '—';
  const ownerName    = xmlField(xml, 'rptOwnerName')        ?? 'Unknown';
  const isDirector   = xmlField(xml, 'isDirector') === '1';
  const isOfficer    = xmlField(xml, 'isOfficer')  === '1';
  const officerTitle = xmlField(xml, 'officerTitle') ?? (isDirector ? 'Director' : 'Insider');
  const role         = isOfficer ? officerTitle : isDirector ? 'Director' : 'Insider (10% owner)';

  return xmlAll(xml, 'nonDerivativeTransaction')
    .filter((b) => xmlField(b, 'transactionCode') === 'P')
    .map((b) => {
      const shares      = parseFloat(xmlField(b, 'transactionShares')        ?? '0') || 0;
      const price       = parseFloat(xmlField(b, 'transactionPricePerShare') ?? '0') || 0;
      const totalValue  = shares * price;
      return {
        company: issuerName, ticker: ticker.toUpperCase(), executive: ownerName, role,
        shares, pricePerShare: price, totalValue,
        transactionDate: xmlField(b, 'transactionDate') ?? '',
        accessionNo, cik,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNo.replace(/-/g, '')}/`,
      };
    })
    .filter((p) => p.totalValue >= MIN_PURCHASE_USD);
}

// ─── Slack helper ───────────────────────────────────────────────────────────

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function buildSlackBlocks(purchases: InsiderPurchase[], asOf: string) {
  const count = purchases.length;
  const rows  = purchases.map((p, i) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*${i + 1}. ${p.ticker} — ${p.company}*\n` +
        `   👤  ${p.executive} _(${p.role})_\n` +
        `   💰  ${formatUSD(p.totalValue)}  ·  ${p.shares.toLocaleString('en-US', { maximumFractionDigits: 0 })} shares @ $${p.pricePerShare.toFixed(2)}\n` +
        `   📅  ${p.transactionDate}  ·  <${p.filingUrl}|View filing>`,
    },
  }));

  return [
    { type: 'header', text: { type: 'plain_text', text: '📊 SEC Insider Purchase Alert', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: count === 0
          ? `No purchases ≥ $${MIN_PURCHASE_USD / 1000}k filed in the last 24 hours.\n_As of ${asOf}_`
          : `*${count} qualifying purchase${count !== 1 ? 's' : ''}* (≥ $${MIN_PURCHASE_USD / 1000}k) filed in the last 24 h — ranked by value.\n_As of ${asOf}_`,
      },
    },
    { type: 'divider' },
    ...rows,
    ...(count > 0 ? [{ type: 'divider' }] : []),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Source: <https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4|SEC EDGAR Form 4> · Code P (open-market purchase)',
      }],
    },
  ];
}

async function postToSlack(purchases: InsiderPurchase[], asOf: string) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not configured');

  const blocks   = buildSlackBlocks(purchases, asOf);
  const fallback = `SEC Insider Alert (${asOf}): ${purchases.length} purchase(s) ≥ $${MIN_PURCHASE_USD / 1000}k found.`;

  const res  = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text: fallback, blocks, unfurl_links: false }),
  });
  const json = await res.json() as { ok: boolean; error?: string; ts?: string };
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json.ts!;
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: Request) {
  // Optional: protect with a shared secret
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const endDate   = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const filings = await searchForm4Filings(yesterday, endDate);

    const CONCURRENCY = 10;
    const allPurchases: InsiderPurchase[] = [];

    for (let i = 0; i < filings.length; i += CONCURRENCY) {
      const batch   = filings.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((f) => parsePurchases(f.cik, f.accessionNo))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allPurchases.push(...r.value);
      }
    }

    allPurchases.sort((a, b) => b.totalValue - a.totalValue);

    const asOf = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
    });

    const slackTs = await postToSlack(allPurchases, asOf);

    return NextResponse.json({
      ok:        true,
      scanned:   filings.length,
      purchases: allPurchases.length,
      slackTs,
      results:   allPurchases,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[edgar-insider-alert]', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
