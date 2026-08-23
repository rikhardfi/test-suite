import { useCanvas } from './hooks'
import { COLORS, FONT, niceTicks } from './theme'

export interface CurveSeries {
  label: string
  color: string
  dashed?: boolean
  points: { durationS: number; value: number }[]
}

const PAD = { top: 10, right: 10, bottom: 22, left: 40 }
const TICKS: [number, string][] = [
  [1, '1s'],
  [5, '5s'],
  [15, '15s'],
  [60, '1m'],
  [300, '5m'],
  [1200, '20m'],
  [3600, '1h'],
]

/**
 * A mean-maximal curve against duration on a logarithmic time axis — the shape
 * that makes a 5 s sprint and a 20 min effort comparable on one plot.
 *
 * Unit-agnostic on purpose: it plots watts for a bike and flat-equivalent speed
 * for a treadmill, and neither is more the chart's business than the other.
 */
export function DurationCurve({
  series,
  decimals = 0,
  minTop = 100,
}: {
  series: CurveSeries[]
  /** Decimals on the value axis. Speed needs one; watts do not. */
  decimals?: number
  /** Floor for the top of the value axis, so an empty chart still has a scale. */
  minTop?: number
}) {
  const ref = useCanvas(
    (ctx, width, height) => {
      const plotW = width - PAD.left - PAD.right
      const plotH = height - PAD.top - PAD.bottom
      if (plotW <= 0 || plotH <= 0) return

      const all = series.flatMap((s) => s.points)
      const maxValue = Math.max(minTop, ...all.map((p) => p.value)) * 1.1
      const minS = 1
      const maxS = 7200

      const x = (d: number) =>
        PAD.left + ((Math.log(Math.max(minS, d)) - Math.log(minS)) / (Math.log(maxS) - Math.log(minS))) * plotW
      const y = (v: number) => PAD.top + plotH - (v / maxValue) * plotH

      ctx.font = `9px ${FONT.mono}`
      ctx.strokeStyle = COLORS.grid
      ctx.lineWidth = 1
      for (const tick of niceTicks(0, maxValue, 4)) {
        const py = Math.round(y(tick)) + 0.5
        ctx.beginPath()
        ctx.moveTo(PAD.left, py)
        ctx.lineTo(width - PAD.right, py)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.textAlign = 'right'
        ctx.fillText(tick.toFixed(decimals), PAD.left - 5, py + 3)
      }

      ctx.textAlign = 'center'
      for (const [seconds, label] of TICKS) {
        const px = Math.round(x(seconds)) + 0.5
        ctx.strokeStyle = COLORS.grid
        ctx.beginPath()
        ctx.moveTo(px, PAD.top)
        ctx.lineTo(px, PAD.top + plotH)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.fillText(label, px, height - PAD.bottom + 13)
      }

      for (const line of series) {
        if (line.points.length < 2) continue
        ctx.beginPath()
        ctx.strokeStyle = line.color
        ctx.lineWidth = 1.5
        ctx.setLineDash(line.dashed ? [4, 3] : [])
        line.points
          .slice()
          .sort((a, b) => a.durationS - b.durationS)
          .forEach((point, index) => {
            const px = x(point.durationS)
            const py = y(point.value)
            if (index === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          })
        ctx.stroke()
      }
      ctx.setLineDash([])
    },
    [series, decimals, minTop],
  )

  return (
    <div className="chart">
      <canvas ref={ref} />
      <ul className="legend">
        {series.map((line) => (
          <li key={line.label} style={{ color: line.color }}>
            {line.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
