import { NextResponse } from 'next/server';
import { fetchRecentInsiderPurchases } from '@/lib/edgar';
import { sendInsiderTradesSummary } from '@/lib/slack';

export async function GET() {
  try {
    const trades = await fetchRecentInsiderPurchases(100_000);

    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
    let slackSent = false;
    let slackError: string | null = null;

    if (slackWebhookUrl) {
      try {
        await sendInsiderTradesSummary(trades, slackWebhookUrl);
        slackSent = true;
      } catch (err) {
        slackError = err instanceof Error ? err.message : String(err);
      }
    }

    return NextResponse.json({
      success: true,
      count: trades.length,
      slackSent,
      ...(slackError ? { slackError } : {}),
      ...(!slackWebhookUrl ? { slackSkipped: 'SLACK_WEBHOOK_URL not configured' } : {}),
      trades: trades.map(t => ({
        rank: trades.indexOf(t) + 1,
        ticker: t.ticker,
        companyName: t.companyName,
        insiderName: t.insiderName,
        insiderTitle: t.insiderTitle,
        shares: t.shares,
        pricePerShare: t.pricePerShare,
        totalValue: t.totalValue,
        transactionDate: t.transactionDate,
        filingDate: t.filingDate,
        edgarUrl: t.edgarUrl,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
