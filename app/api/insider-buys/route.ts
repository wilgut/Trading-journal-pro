import { NextResponse } from 'next/server'
import { fetchInsiderPurchases } from '@/lib/edgar'
import { sendInsiderPurchaseAlert } from '@/lib/slack'

// Allow up to 5 minutes — processing ~150 Form 4 filings takes ~30–60 s
export const maxDuration = 300

export async function GET(req: Request) {
  // Optional bearer-token guard so only your cron service can trigger this
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const purchases = await fetchInsiderPurchases(100_000)
    await sendInsiderPurchaseAlert(purchases)

    return NextResponse.json({
      success: true,
      count: purchases.length,
      topPurchases: purchases.slice(0, 10).map(p => ({
        ticker: p.issuerTicker || p.issuerName,
        issuerName: p.issuerName,
        owner: p.ownerName,
        title: p.ownerTitle,
        totalValue: p.totalValue,
        shares: p.shares,
        pricePerShare: p.pricePerShare,
        transactionDate: p.transactionDate,
        filingUrl: p.filingUrl,
      })),
    })
  } catch (err) {
    console.error('[insider-buys] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
