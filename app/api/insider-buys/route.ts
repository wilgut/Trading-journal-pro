import { NextResponse } from 'next/server'
import { fetchInsiderBuys } from '@/lib/edgar'
import { sendSlackSummary } from '@/lib/slack'

// Allow up to 5 minutes — fetching and parsing hundreds of Form 4 XMLs takes time
export const maxDuration = 300

export async function GET() {
  try {
    const allBuys = await fetchInsiderBuys()

    // Keep only open-market purchases exceeding $100k
    const filtered = allBuys.filter(b => b.totalValue >= 100_000)

    // Rank highest value first
    const ranked = filtered.sort((a, b) => b.totalValue - a.totalValue)

    await sendSlackSummary(ranked)

    return NextResponse.json({
      success: true,
      totalFilingsScanned: allBuys.length,
      qualifyingPurchases: ranked.length,
      data: ranked,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[insider-buys]', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

// Also accept POST so the route can be triggered by a cron webhook
export const POST = GET
