import { useCanvas } from './hooks'
import { COLORS, FONT, niceTicks } from './theme'
import { curveSamples, sortPoints, type LactatePoint, type ThresholdResult } from '../model/analysis'

interface Props {
  points: LactatePoint[]
  thresholds: ThresholdResult[]
  unit: string
}

const PAD = { top: 16, right: 46, bottom: 34, left: 46 }

/**
 * Measured lactate against intensity with the fitted third-order curve, heart
 * rate on the right axis, and a marker per threshold method so the reader can
 * see how far apart the methods land.
 */
export function LactateChart({ points, thresholds, unit }: Props) {
  const ref = useCanvas(
    (ctx, width, height) => {
      const sorted = sortPoints(points)
      const plotW = width - PAD.left - PAD.right
      const plotH = height - PAD.top - PAD.bottom
      if (plotW <= 0 || plotH <= 0) return

      if (sorted.length < 2) {
        ctx.fillStyle = COLORS.muted
        ctx.font = `12px ${FONT.ui}`
        ctx.textAlign = 'center'
        ctx.fillText('Enter at least two lactate samples', width / 2, height / 2)
        return
      }

      const xMin = sorted[0].intensity
      const xMax = sorted[sorted.length - 1].intensity
      const yMax = Math.max(...sorted.map((p) => p.lactate)) * 1.15
      const hrValues = sorted.map((p) => p.heartRate).filter((v): v is number => v != null)
      const hrMin = hrValues.length ? Math.min(...hrValues) - 8 : 0
      const hrMax = hrValues.length ? Math.max(...hrValues) + 8 : 200

      const x = (v: number) => PAD.left + ((v - xMin) / Math.max(1e-6, xMax - xMin)) * plotW
      const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH
      const yHr = (v: number) => PAD.top + plotH - ((v - hrMin) / Math.max(1, hrMax - hrMin)) * plotH

      ctx.font = `10px ${FONT.mono}`
      for (const tick of niceTicks(0, yMax, 5)) {
        const py = Math.round(y(tick)) + 0.5
        ctx.strokeStyle = COLORS.grid
        ctx.beginPath()
        ctx.moveTo(PAD.left, py)
        ctx.lineTo(width - PAD.right, py)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.textAlign = 'right'
        ctx.fillText(tick.toFixed(1), PAD.left - 6, py + 3)
      }
      ctx.textAlign = 'center'
      for (const tick of niceTicks(xMin, xMax, 5)) {
        ctx.fillStyle = COLORS.axis
        ctx.fillText(tick.toFixed(0), x(tick), height - PAD.bottom + 15)
      }
      ctx.fillStyle = COLORS.muted
      ctx.fillText(unit, width / 2, height - 6)

      // Threshold markers first, so the data sits on top of them. Labels run
      // vertically up each line: six methods a few watts apart would otherwise
      // overlap into an unreadable pile.
      for (const threshold of thresholds) {
        if (threshold.intensity == null) continue
        if (threshold.intensity < xMin || threshold.intensity > xMax) continue
        const px = Math.round(x(threshold.intensity)) + 0.5
        ctx.strokeStyle = COLORS.gridStrong
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(px, PAD.top)
        ctx.lineTo(px, PAD.top + plotH)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.save()
        ctx.translate(px - 3, PAD.top + plotH - 4)
        ctx.rotate(-Math.PI / 2)
        ctx.fillStyle = COLORS.muted
        ctx.font = `9px ${FONT.mono}`
        ctx.textAlign = 'left'
        ctx.fillText(threshold.label, 0, 0)
        ctx.restore()
      }

      if (hrValues.length > 1) {
        ctx.beginPath()
        ctx.strokeStyle = COLORS.heartRate
        ctx.lineWidth = 1.2
        sorted
          .filter((p) => p.heartRate != null)
          .forEach((p, i) => {
            const px = x(p.intensity)
            const py = yHr(p.heartRate as number)
            if (i === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          })
        ctx.stroke()

        ctx.font = `10px ${FONT.mono}`
        ctx.textAlign = 'left'
        for (const tick of niceTicks(hrMin, hrMax, 4)) {
          ctx.fillStyle = COLORS.heartRate
          ctx.fillText(tick.toFixed(0), width - PAD.right + 6, yHr(tick) + 3)
        }
      }

      const fitted = curveSamples(sorted)
      if (fitted.length) {
        ctx.beginPath()
        ctx.strokeStyle = COLORS.lactate
        ctx.lineWidth = 1.8
        fitted.forEach((point, i) => {
          const px = x(point.intensity)
          const py = y(Math.max(0, point.lactate))
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()
      }

      ctx.fillStyle = COLORS.lactate
      for (const point of sorted) {
        ctx.beginPath()
        ctx.arc(x(point.intensity), y(point.lactate), 3.2, 0, Math.PI * 2)
        ctx.fill()
      }
    },
    [points, thresholds, unit],
  )

  return (
    <div className="chart">
      <canvas ref={ref} />
      <ul className="legend">
        <li style={{ color: COLORS.lactate }}>Lactate mmol/L</li>
        <li style={{ color: COLORS.heartRate }}>Heart rate</li>
      </ul>
    </div>
  )
}
