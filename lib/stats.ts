// Utilidades estadísticas para normalización y métricas.

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

// Desviación estándar muestral.
export function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}

// Cuantil sobre un array ya ordenado ascendentemente (interpolación lineal).
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// Z-scores transversales con winsorización al 2%/98% para limitar outliers.
// Si higherBetter es false, se invierte el signo (menor es mejor).
// Los valores nulos/no finitos devuelven null en la misma posición.
export function winsorizedZScores(
  values: (number | null)[],
  higherBetter = true
): (number | null)[] {
  const valid = values.filter(
    (v): v is number => v != null && Number.isFinite(v)
  )
  if (valid.length < 3) return values.map(() => null)

  const sorted = [...valid].sort((a, b) => a - b)
  const lo = quantile(sorted, 0.02)
  const hi = quantile(sorted, 0.98)
  const clip = (v: number) => Math.min(hi, Math.max(lo, v))

  const clipped = valid.map(clip)
  const m = mean(clipped)
  const s = std(clipped)

  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null
    if (s === 0) return 0
    const z = (clip(v) - m) / s
    return higherBetter ? z : -z
  })
}
