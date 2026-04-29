import type { InsiderBuy } from './edgar';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DEC = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function roleBadge(buy: InsiderBuy): string {
  if (buy.isDirector && buy.isOfficer) return 'Director & Officer';
  if (buy.isDirector) return 'Director';
  return 'Officer';
}

function rankEmoji(i: number): string {
  return ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'][i] ?? `${i + 1}.`;
}

export function formatInsiderBuysMessage(
  buys: InsiderBuy[],
  minValueUSD: number,
  windowHours: number,
): string {
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  if (buys.length === 0) {
    return (
      `*SEC EDGAR Insider Buying Scanner* — ${timestamp} ET\n` +
      `_No purchases ≥ ${USD.format(minValueUSD)} by directors/officers found in the last ${windowHours}h._`
    );
  }

  const totalDeployed = buys.reduce((s, b) => s + b.totalValue, 0);
  const lines: string[] = [
    `*SEC EDGAR Insider Buying Scanner* — ${timestamp} ET`,
    `*Window:* Last ${windowHours}h  |  *Min threshold:* ${USD.format(minValueUSD)}  |  *Matches:* ${buys.length}  |  *Total deployed:* ${USD.format(totalDeployed)}`,
    '─'.repeat(48),
  ];

  for (let i = 0; i < buys.length; i++) {
    const b = buys[i];
    const ticker = b.ticker ? `*${b.ticker}*` : '*N/A*';
    const value = USD.format(b.totalValue);
    const shares = NUM.format(b.shares);
    const price = DEC.format(b.pricePerShare);
    const badge = roleBadge(b);

    lines.push(
      `${rankEmoji(i)} ${ticker} — ${b.companyName}`,
      `   👤 ${b.insiderName} _(${badge}: ${b.insiderTitle})_`,
      `   💰 *${value}*  (${shares} shares @ $${price})`,
      `   📅 ${b.transactionDate}  |  <${b.filingUrl}|SEC Filing>`,
    );

    if (i < buys.length - 1) lines.push('');
  }

  return lines.join('\n');
}
