// Cálculo de factores basados en precio: Momentum y Low Volatility.
// Las series de cierre se esperan ordenadas ascendentemente (más antigua -> más reciente).

import { std } from './stats'

const TD_MONTH = 21 // días de trading aproximados por mes
const TD_YEAR = 252

// Momentum evaluado en el índice endIdx de la serie de cierres.
// mom12_1: retorno desde ~12 meses atrás hasta ~1 mes atrás (excluye el último mes).
// mom6_1: retorno desde ~6 meses atrás hasta ~1 mes atrás.
export function momentumAt(
  closes: number[],
  endIdx: number
): { mom12_1: number | null; mom6_1: number | null } {
  const at = (back: number): number | null => {
    const i = endIdx - back
    return i >= 0 && i < closes.length ? closes[i] : null
  }
  const ret = (recentBack: number, oldBack: number): number | null => {
    const recent = at(recentBack)
    const old = at(oldBack)
    if (recent == null || old == null || old <= 0) return null
    return recent / old - 1
  }
  return {
    mom12_1: ret(TD_MONTH, TD_YEAR),
    mom6_1: ret(TD_MONTH, TD_MONTH * 6),
  }
}

export function momentum(closes: number[]): {
  mom12_1: number | null
  mom6_1: number | null
} {
  return momentumAt(closes, closes.length - 1)
}

// Volatilidad anualizada de los retornos diarios en la ventana previa a endIdx.
export function annualizedVolatilityAt(
  closes: number[],
  endIdx: number,
  lookback = TD_YEAR
): number | null {
  if (endIdx < 20) return null
  const start = Math.max(1, endIdx - lookback + 1)
  const rets: number[] = []
  for (let i = start; i <= endIdx && i < closes.length; i++) {
    const p0 = closes[i - 1]
    const p1 = closes[i]
    if (p0 > 0 && p1 > 0) rets.push(p1 / p0 - 1)
  }
  if (rets.length < 20) return null
  return std(rets) * Math.sqrt(TD_YEAR)
}

export function annualizedVolatility(
  closes: number[],
  lookback = TD_YEAR
): number | null {
  return annualizedVolatilityAt(closes, closes.length - 1, lookback)
}
