import { useCanvas } from './hooks'
import { COLORS, FONT, axisFloor, niceTicks } from './theme'
import { nomogramCurves } from '../model/running'
import { computeVo2, solveInclineForVo2, solveSpeedForVo2 } from '../model/vo2'

const PAD = { top: 12, right: 34, bottom: 24, left: 40 }
const FROM_KPH = 4
const TO_KPH = 20

/**
 * Speed, gradient and oxygen cost on one plot, with the athlete on it.
 *
 * One line per gradient; the live point sits where the treadmill actually is.
 * Read it in whichever direction the question runs — what a gradient change
 * buys at this pace, what pace holds this cost one step steeper, or what a
 * planned step is going to demand before anybody runs it.
 *
 * Every line is the ACSM walking/running equation, the same one that resolves a
 * VO₂-mode step into a treadmill speed, so the chart and the targets cannot
 * disagree. It is a population regression, not a measurement, and the panel
 * says so.
 */
export function Nomogram({
  speedKph,
  inclinePct,
  economyPct = 100,
  vo2max,
  fitY = false,
}: {
  /** Start the oxygen-cost axis just under the cheapest plotted pace rather than at zero. */
  fitY?: boolean
  speedKph: number | null
  inclinePct: number | null
  economyPct?: number
  /** Drawn as a ceiling line when the athlete has a measured maximum. */
  vo2max?: number
}) {
  const curves = nomogramCurves(FROM_KPH, TO_KPH, economyPct)

  const ref = useCanvas(
    (ctx, width, height) => {
      const plotW = width - PAD.left - PAD.right
      const plotH = height - PAD.top - PAD.bottom
      if (plotW <= 0 || plotH <= 0) return

      const maxVo2 = Math.max(
        70,
        vo2max ? vo2max * 1.1 : 0,
        ...curves.flatMap((c) => c.points.map((p) => p.vo2)),
      )
      const minVo2 = axisFloor(fitY, Math.min(...curves.flatMap((c) => c.points.map((p) => p.vo2))), maxVo2, 5)
      const x = (kph: number) => PAD.left + ((kph - FROM_KPH) / (TO_KPH - FROM_KPH)) * plotW
      const y = (vo2: number) => PAD.top + plotH - ((vo2 - minVo2) / (maxVo2 - minVo2)) * plotH

      ctx.font = `9px ${FONT.mono}`

      // Oxygen cost up the side.
      for (const tick of niceTicks(minVo2, maxVo2, 5)) {
        const py = Math.round(y(tick)) + 0.5
        ctx.strokeStyle = COLORS.grid
        ctx.beginPath()
        ctx.moveTo(PAD.left, py)
        ctx.lineTo(width - PAD.right, py)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.textAlign = 'right'
        ctx.fillText(tick.toFixed(0), PAD.left - 5, py + 3)
      }

      // Speed along the bottom.
      ctx.textAlign = 'center'
      for (let kph = FROM_KPH; kph <= TO_KPH; kph += 2) {
        const px = Math.round(x(kph)) + 0.5
        ctx.strokeStyle = COLORS.grid
        ctx.beginPath()
        ctx.moveTo(px, PAD.top)
        ctx.lineTo(px, PAD.top + plotH)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.fillText(String(kph), px, height - PAD.bottom + 13)
      }

      // The gradient the treadmill is actually on is drawn last and brightest,
      // so the line being read is never one of eight identical ones.
      const nearest =
        inclinePct == null
          ? null
          : curves.reduce((best, c) =>
              Math.abs(c.inclinePct - inclinePct) < Math.abs(best.inclinePct - inclinePct) ? c : best,
            )

      for (const curve of curves) {
        const live = curve === nearest
        ctx.beginPath()
        ctx.strokeStyle = live ? COLORS.target : COLORS.grid
        ctx.lineWidth = live ? 2 : 1
        curve.points.forEach((point, index) => {
          const px = x(point.speedKph)
          const py = y(point.vo2)
          if (index === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()

        const end = curve.points[curve.points.length - 1]
        ctx.fillStyle = live ? COLORS.target : COLORS.axis
        ctx.textAlign = 'left'
        ctx.fillText(`${curve.inclinePct}%`, x(end.speedKph) + 4, y(end.vo2) + 3)
      }

      if (vo2max) {
        const py = Math.round(y(vo2max)) + 0.5
        ctx.strokeStyle = COLORS.lactate
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.moveTo(PAD.left, py)
        ctx.lineTo(width - PAD.right, py)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = COLORS.lactate
        ctx.textAlign = 'left'
        ctx.fillText('VO₂max', PAD.left + 4, py - 4)
      }

      // Where the athlete is, with the lines that let it be read off the axes.
      if (speedKph != null && speedKph > 0) {
        const live = computeVo2(speedKph, inclinePct ?? 0, economyPct).vo2
        const px = x(Math.min(TO_KPH, Math.max(FROM_KPH, speedKph)))
        const py = y(Math.min(maxVo2, live))

        ctx.strokeStyle = COLORS.cursor
        ctx.setLineDash([2, 3])
        ctx.beginPath()
        ctx.moveTo(PAD.left, py)
        ctx.lineTo(px, py)
        ctx.moveTo(px, PAD.top + plotH)
        ctx.lineTo(px, py)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.fillStyle = COLORS.cursor
        ctx.beginPath()
        ctx.arc(px, py, 4.5, 0, Math.PI * 2)
        ctx.fill()
      }
    },
    [curves, speedKph, inclinePct, economyPct, vo2max, fitY],
  )

  const vo2 =
    speedKph && speedKph > 0 ? computeVo2(speedKph, inclinePct ?? 0, economyPct).vo2 : null
  // What the next click of the gradient dial costs, which is the question this
  // panel exists to answer during a step test.
  const oneStepSteeper =
    vo2 == null || speedKph == null
      ? null
      : computeVo2(speedKph, (inclinePct ?? 0) + 1, economyPct).vo2 - vo2
  const sameCostSpeed =
    vo2 == null ? null : solveSpeedForVo2(vo2, (inclinePct ?? 0) + 1, economyPct)
  const sameCostGrade =
    vo2 == null || speedKph == null
      ? null
      : solveInclineForVo2(vo2, speedKph + 1, economyPct)

  return (
    <div className="nomogram">
      <div className="chart">
        <canvas ref={ref} />
      </div>
      <dl className="nomogram-readout">
        <div>
          <dt>Now</dt>
          <dd>{vo2 == null ? '—' : `${vo2.toFixed(1)} mL/kg/min`}</dd>
        </div>
        <div>
          <dt>+1% gradient</dt>
          <dd>{oneStepSteeper == null ? '—' : `+${oneStepSteeper.toFixed(1)}`}</dd>
        </div>
        <div>
          <dt>Same cost at +1%</dt>
          <dd>{sameCostSpeed == null ? '—' : `${sameCostSpeed.toFixed(1)} km/h`}</dd>
        </div>
        <div>
          <dt>Same cost at +1 km/h</dt>
          <dd>{sameCostGrade == null ? '—' : `${sameCostGrade.toFixed(1)}%`}</dd>
        </div>
      </dl>
    </div>
  )
}
