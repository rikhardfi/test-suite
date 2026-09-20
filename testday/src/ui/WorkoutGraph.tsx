import { useMemo } from 'react'
import { useCanvas } from './hooks'
import { COLORS, FONT, axisFloor, niceTicks } from './theme'
import { formatClock } from '../model/metrics'
import { planPowerSeries, planSpeedSeries, stepBoundaries, type Athlete, type Protocol } from '../model/protocol'
import type { Sample } from '../model/session'

interface Props {
  protocol: Protocol
  athlete: Athlete
  samples: readonly Sample[]
  elapsedS: number
  /** Start the value axis just under the lowest step rather than at zero. */
  fitY?: boolean
}

const PAD = { top: 14, right: 54, bottom: 26, left: 52 }

/**
 * The plan for the whole session as a stepped area, with the recorded power,
 * heart rate and pace drawn over it and a cursor at the current second.
 *
 * Power and pace share the left axis by scaling pace into the power range —
 * the two are never compared numerically, only by shape.
 */
export function WorkoutGraph({ protocol, athlete, samples, elapsedS, fitY = false }: Props) {
  const plan = useMemo(
    () => ({
      // The plan trace now draws the protocol's own recovery target, so what is
      // shown during a break is what the trainer will actually be sent.
      power: planPowerSeries(protocol, athlete.ftpWatts),
      speed: protocol.sport === 'run' ? planSpeedSeries(protocol, athlete.economyPct ?? 100) : [],
      boundaries: stepBoundaries(protocol),
    }),
    [protocol, athlete.ftpWatts, athlete.economyPct],
  )

  const ref = useCanvas(
    (ctx, width, height) => {
      const totalS = Math.max(plan.power.length, samples.length, 60)
      const plotW = width - PAD.left - PAD.right
      const plotH = height - PAD.top - PAD.bottom
      if (plotW <= 0 || plotH <= 0) return

      const isRun = protocol.sport === 'run'
      const planPeak = Math.max(...(isRun ? plan.speed : plan.power), 1)
      // The axis is in the sport's own unit. A running pod's watts on a km/h
      // axis stretched it to a hundred and flattened the plan against the floor.
      const actualPeak = samples.reduce(
        (m, s) => Math.max(m, (isRun ? (s.speedMs ?? 0) * 3.6 : s.power) ?? 0),
        0,
      )
      const maxPrimary = Math.max(planPeak * 1.15, actualPeak * 1.05, 1)
      // Fitted to the steps, not to the breaks between them or to the recorded
      // trace: a sampling break at 90 W, or the first pedal stroke from rest,
      // would drag the floor back to where it started.
      const planned = isRun ? plan.speed : plan.power
      const stepStarts = plan.boundaries.map((mark) => planned[mark]).filter((v) => v > 0)
      const minPrimary = axisFloor(fitY, Math.min(...stepStarts), maxPrimary)

      const hrValues = samples.map((s) => s.heartRate).filter((v): v is number => v != null)
      const hrMin = hrValues.length ? Math.min(...hrValues, 60) : 40
      const hrMax = hrValues.length ? Math.max(...hrValues, athlete.maxHr ?? 190) : 200

      const x = (t: number) => PAD.left + (t / totalS) * plotW
      const yPrimary = (v: number) =>
        PAD.top + plotH - ((v - minPrimary) / (maxPrimary - minPrimary)) * plotH
      const yHr = (v: number) => PAD.top + plotH - ((v - hrMin) / Math.max(1, hrMax - hrMin)) * plotH

      // --- grid ---
      ctx.font = `10px ${FONT.mono}`
      ctx.strokeStyle = COLORS.grid
      ctx.lineWidth = 1
      for (const tick of niceTicks(minPrimary, maxPrimary, 4)) {
        const y = Math.round(yPrimary(tick)) + 0.5
        ctx.beginPath()
        ctx.moveTo(PAD.left, y)
        ctx.lineTo(width - PAD.right, y)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.textAlign = 'right'
        ctx.fillText(isRun ? `${tick.toFixed(0)}km/h` : `${tick.toFixed(0)}W`, PAD.left - 6, y + 3)
      }
      for (const tick of niceTicks(hrMin, hrMax, 4)) {
        ctx.fillStyle = COLORS.heartRate
        ctx.textAlign = 'left'
        ctx.fillText(`${tick.toFixed(0)}`, width - PAD.right + 6, yHr(tick) + 3)
      }

      // Everything from here to the cursor is data, and on a fitted axis some of
      // it lies under the floor. Clipped, it leaves the plot at the bottom edge
      // instead of being drawn across the time axis.
      ctx.save()
      ctx.beginPath()
      ctx.rect(PAD.left, PAD.top, plotW, plotH)
      ctx.clip()

      // --- plan area ---
      const planSeries = planned
      if (planSeries.length) {
        ctx.beginPath()
        ctx.moveTo(x(0), yPrimary(0))
        for (let t = 0; t < planSeries.length; t++) {
          ctx.lineTo(x(t), yPrimary(planSeries[t]))
          ctx.lineTo(x(t + 1), yPrimary(planSeries[t]))
        }
        ctx.lineTo(x(planSeries.length), yPrimary(0))
        ctx.closePath()
        ctx.fillStyle = COLORS.plan
        ctx.fill()
        ctx.strokeStyle = COLORS.planLine
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // --- step boundaries ---
      ctx.strokeStyle = COLORS.grid
      for (const mark of plan.boundaries) {
        const px = Math.round(x(mark)) + 0.5
        ctx.beginPath()
        ctx.moveTo(px, PAD.top)
        ctx.lineTo(px, PAD.top + plotH)
        ctx.stroke()
      }

      // --- recorded series ---
      if (!isRun) trace(ctx, samples, (s) => s.power, x, yPrimary, COLORS.power, 1.4)
      if (isRun) {
        trace(ctx, samples, (s) => (s.speedMs != null ? s.speedMs * 3.6 : undefined), x, yPrimary, COLORS.pace, 1.2)
      } else {
        trace(ctx, samples, (s) => s.speedMs, x, (v) => yPrimary(v * 8), COLORS.pace, 1)
      }
      trace(ctx, samples, (s) => s.heartRate, x, yHr, COLORS.heartRate, 1.4)
      ctx.restore()

      // --- cursor ---
      const cursorX = Math.round(x(Math.min(elapsedS, totalS))) + 0.5
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = COLORS.cursor
      ctx.beginPath()
      ctx.moveTo(cursorX, PAD.top)
      ctx.lineTo(cursorX, PAD.top + plotH)
      ctx.stroke()
      ctx.setLineDash([])

      // --- time axis ---
      ctx.fillStyle = COLORS.axis
      ctx.textAlign = 'center'
      const tickStep = timeTickStep(totalS)
      for (let t = 0; t <= totalS; t += tickStep) {
        ctx.fillText(formatClock(t), x(t), height - PAD.bottom + 15)
      }
    },
    [protocol.id, plan, samples.length, elapsedS, athlete.ftpWatts, athlete.maxHr, protocol.sport, fitY],
  )

  return (
    <div className="chart">
      <canvas ref={ref} />
      <ul className="legend">
        {protocol.sport === 'bike' && <li style={{ color: COLORS.power }}>Power</li>}
        <li style={{ color: COLORS.heartRate }}>Heart rate</li>
        <li style={{ color: COLORS.pace }}>{protocol.sport === 'run' ? 'Speed' : 'Speed ×8'}</li>
        <li style={{ color: COLORS.planLine }}>Plan</li>
      </ul>
    </div>
  )
}

function trace(
  ctx: CanvasRenderingContext2D,
  samples: readonly Sample[],
  pick: (s: Sample) => number | undefined,
  x: (t: number) => number,
  y: (v: number) => number,
  color: string,
  lineWidth: number,
): void {
  ctx.beginPath()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  let drawing = false
  for (const sample of samples) {
    const value = pick(sample)
    if (value == null || !Number.isFinite(value)) {
      drawing = false
      continue
    }
    const px = x(sample.t)
    const py = y(value)
    if (drawing) ctx.lineTo(px, py)
    else ctx.moveTo(px, py)
    drawing = true
  }
  ctx.stroke()
}

function timeTickStep(totalS: number): number {
  for (const step of [60, 120, 300, 600, 900, 1200, 1800, 3600]) {
    if (totalS / step <= 8) return step
  }
  return 3600
}
