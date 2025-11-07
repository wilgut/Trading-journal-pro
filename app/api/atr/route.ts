import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol') || 'SPY'
  const end = new Date(searchParams.get('end') || Date.now())
  const period = Number(searchParams.get('period') || 14)

  // Calcula el rango de fechas (200 días hacia atrás) para pedir datos históricos
  const start = new Date(end)
  start.setDate(start.getDate() - 200)

  const period1 = Math.floor(start.getTime() / 1000) // fecha inicio en segundos (UNIX)
  const period2 = Math.floor(end.getTime() / 1000)   // fecha fin en segundos (UNIX)

  // Llama a la API de Yahoo Finance para obtener datos OHLC diarios
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`
  )
  const data = await res.json()
  const result = data.chart?.result?.[0]
  if (!result) {
    return NextResponse.json({ atr: null })
  }

  const highs = result.indicators?.quote?.[0]?.high || []
  const lows = result.indicators?.quote?.[0]?.low || []
  const closes = result.indicators?.quote?.[0]?.close || []

  // Comprueba que hay suficientes datos para calcular el ATR
  if (highs.length < period + 1) {
    return NextResponse.json({ atr: null })
  }

  // Calcula el True Range para cada vela
  let prevClose: number | null = null
  const tr: number[] = []
  for (let i = 0; i < highs.length; i++) {
    const high = highs[i]
    const low = lows[i]
    if (prevClose == null) {
      tr.push(high - low)
    } else {
      tr.push(
        Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        )
      )
    }
    prevClose = closes[i]
  }

  // Calcula el ATR con media móvil exponencial (como tenías)
  let atrValue =
    tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < tr.length; i++) {
    atrValue = (atrValue * (period - 1) + tr[i]) / period
  }

  return NextResponse.json({ atr: atrValue })
}
