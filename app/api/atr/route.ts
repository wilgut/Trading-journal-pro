import { NextResponse } from 'next/server'
import yf from 'yahoo-finance2'
export async function GET(req: Request){
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol') || 'SPY'
  const end = new Date(searchParams.get('end') || Date.now())
  const period = Number(searchParams.get('period')||14)
  const start = new Date(end); start.setDate(start.getDate() - 200)
  const hist = await yf.historical(symbol, { period1: start, period2: end, interval: '1d' })
  if(!hist?.length) return NextResponse.json({ atr: null })
  let prevClose: number | null = null
  const TR: number[] = []
  for(const k of hist){
    const high = k.high as number; const low = k.low as number; const close = k.close as number
    if(prevClose==null){ TR.push(high-low) } else { TR.push(Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose))) }
    prevClose = close
  }
  if(TR.length < period) return NextResponse.json({ atr: null })
  let atr = TR.slice(0, period).reduce((a,b)=>a+b,0)/period
  for(let i=period;i<TR.length;i++){ atr = (atr*(period-1) + TR[i]) / period }
  return NextResponse.json({ atr })
}
