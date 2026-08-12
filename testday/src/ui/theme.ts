/** Single source of truth for series colours, shared by CSS and canvas. */
export const COLORS = {
  power: '#e8ecd0',
  target: '#8fd3ff',
  plan: '#173e58',
  planLine: '#2b7fb8',
  heartRate: '#f07ac0',
  cadence: '#c9b6ff',
  pace: '#38bdf8',
  lactate: '#ff9f5a',
  grid: '#1b2431',
  gridStrong: '#2a3648',
  axis: '#6b7a8f',
  text: '#e6edf5',
  muted: '#8494a8',
  cursor: '#dbe6f2',
} as const

export const FONT = {
  mono: "'SF Mono', 'JetBrains Mono', 'Fira Mono', ui-monospace, monospace",
  ui: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
} as const

/** Even ~1-2-5 tick steps spanning a range. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const rawStep = (max - min) / count
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalised = rawStep / magnitude
  const step = (normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1) * magnitude

  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step * 0.001; t += step) {
    ticks.push(Number(t.toFixed(6)))
  }
  return ticks
}
