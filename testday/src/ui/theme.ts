/**
 * Single source of truth for series colours, shared by CSS and canvas.
 *
 * These are the KIHU Brand Book (11 March 2022) colours, taken from the
 * `kihuplot` R package so a canvas chart here and a ggplot figure there use the
 * same hex values. The dashboard is drawn on the brand dark blue, so the series
 * come from the brand's dark-background accent set.
 *
 * The brand book restricts green (#02890A) and red (#DF0000) to graphs and
 * forbids them in layout. Neither appears here, because the dark-background set
 * supplies lightgreen instead.
 */

/** The brand palette by name, matching `kihuplot::kihu_cols()`. */
export const KIHU = {
  navy: '#252F48',
  grey: '#697F90',
  lightgrey: '#D0DCE0',
  black: '#000000',
  white: '#FFFFFF',
  violet: '#403A60',
  // Accessible on a light background.
  blue: '#234FE0',
  magenta: '#C8368B',
  green: '#02890A',
  purple: '#61358B',
  red: '#DF0000',
  // Accessible on a dark background: what this app draws with.
  cyan: '#68D2DF',
  pink: '#FF65E6',
  lightgreen: '#6AEA6F',
  lightpurple: '#B363FF',
  orange: '#FF922D',
} as const

export const COLORS = {
  power: KIHU.cyan,
  target: KIHU.lightgreen,
  /** The planned trace sits behind the live one, so it is a muted navy tint. */
  plan: '#2F3E63',
  planLine: KIHU.grey,
  heartRate: KIHU.pink,
  cadence: KIHU.lightgrey,
  pace: KIHU.cyan,
  lactate: KIHU.lightpurple,
  coreTemp: KIHU.orange,
  skinTemp: KIHU.grey,
  grid: '#3A4767',
  gridStrong: '#4D5C84',
  axis: KIHU.grey,
  text: KIHU.white,
  muted: KIHU.lightgrey,
  cursor: KIHU.white,
} as const

export const FONT = {
  mono: "'Roboto Mono', 'Consolas', ui-monospace, monospace",
  ui: "'Roboto', 'Arial', system-ui, -apple-system, sans-serif",
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
