import { useCanvas } from './hooks'
import { COLORS, FONT, KIHU, niceTicks } from './theme'
import { BAND, GENERATIONS } from '../model/karamaoun'
import type { PersonalAirway } from '../model/personalAirway'

const PAD = { top: 10, right: 10, bottom: 22, left: 40 }

/**
 * The athlete's own Figure 2 of Karamaoun et al. 2022, live: evaporation flux
 * per airway generation against the gland-replenishment band.
 *
 * Bold cyan is the current TSI VE (solid: Karamaoun's figure moved to this
 * FRC and room; dashed: the Haut 2021 model on the same FRC). Pink is the VE
 * the heart rate predicts. Faint grey lines are the curves at the two
 * thresholds, so the operator sees how far the live line sits from them.
 */
export function AirwayCurve({ personal }: { personal: PersonalAirway | null }) {
  const ref = useCanvas(
    (ctx, width, height) => {
      const plotW = width - PAD.left - PAD.right
      const plotH = height - PAD.top - PAD.bottom
      if (plotW <= 0 || plotH <= 0 || !personal) return
      const all = [
        ...(personal.tsi?.curve.karamaoun ?? []),
        ...(personal.tsi?.curve.haut ?? []),
        ...(personal.hr?.curve.karamaoun ?? []),
      ]
      const top = Math.max(0.6, ...all) * 1.08
      const x = (g: number) => PAD.left + ((g - 1) / (GENERATIONS - 1)) * plotW
      const y = (v: number) => PAD.top + plotH - (v / top) * plotH

      ctx.font = `9px ${FONT.mono}`
      ctx.lineWidth = 1
      for (const tick of niceTicks(0, top, 4)) {
        const py = Math.round(y(tick)) + 0.5
        ctx.strokeStyle = COLORS.grid
        ctx.beginPath()
        ctx.moveTo(PAD.left, py)
        ctx.lineTo(width - PAD.right, py)
        ctx.stroke()
        ctx.fillStyle = COLORS.axis
        ctx.textAlign = 'right'
        ctx.fillText(tick.toFixed(1), PAD.left - 5, py + 3)
      }
      ctx.textAlign = 'center'
      for (const g of [1, 4, 8, 12, 17]) {
        ctx.fillStyle = COLORS.axis
        ctx.fillText(g === 1 ? '1 trachea' : String(g), x(g), height - PAD.bottom + 13)
      }

      // the band
      ctx.fillStyle = 'rgba(208, 220, 224, 0.18)'
      ctx.fillRect(PAD.left, y(BAND.high), plotW, y(BAND.low) - y(BAND.high))

      const line = (values: number[], color: string, widthPx: number, dash: number[] = []) => {
        ctx.beginPath()
        ctx.strokeStyle = color
        ctx.lineWidth = widthPx
        ctx.setLineDash(dash)
        values.forEach((v, i) => (i ? ctx.lineTo(x(i + 1), y(v)) : ctx.moveTo(x(i + 1), y(v))))
        ctx.stroke()
      }
      for (const r of personal.references) line(r.curve, COLORS.planLine, 1, [2, 3])
      if (personal.hr) line(personal.hr.curve.karamaoun, KIHU.pink, 1.5)
      if (personal.tsi) {
        if (personal.tsi.curve.haut) line(personal.tsi.curve.haut, KIHU.cyan, 1.5, [4, 3])
        line(personal.tsi.curve.karamaoun, KIHU.cyan, personal.tsi.heldS != null ? 1.5 : 3, personal.tsi.heldS != null ? [1, 2] : [])
      }
      ctx.setLineDash([])
    },
    [personal],
  )

  // The canvas is always mounted: useCanvas measures its parent once, at mount,
  // and the panel usually appears before the spirometry and room air are known.
  if (!personal) {
    return (
      <div className="airway-chart">
        <div className="chart">
          <canvas ref={ref} />
          <div className="empty small" style={{ position: 'absolute', inset: 0, padding: 16 }}>
            Import the athlete&apos;s spirometry (Settings → Athlete) and enter the room temperature and humidity to
            see the airway curve.
          </div>
        </div>
      </div>
    )
  }
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '∞')
  const tsi = personal.tsi
  return (
    <div className="airway-chart">
      <div className="chart">
      <canvas ref={ref} />
      <ul className="legend">
        <li style={{ color: KIHU.cyan }}>
          TSI {tsi ? tsi.veLMin.toFixed(0) : '–'}
          {tsi?.heldS != null ? ` held ${Math.round(tsi.heldS / 60)} min` : ''}
        </li>
        <li style={{ color: KIHU.pink }}>HR {personal.hr ? personal.hr.veLMin.toFixed(0) : '–'}</li>
        <li style={{ color: COLORS.planLine }}>
          threshold {fmt(personal.threshold.hautShifted[1])} Haut · {fmt(personal.threshold.waterDeficit[1])} water
        </li>
      </ul>
      </div>
      <div className="chart-caption muted small">
        L/min · FRC {personal.frcL.toFixed(2)} L ({personal.frcSource}) · {personal.room.tempC.toFixed(1)} °C{' '}
        {personal.room.humidityPct.toFixed(0)} %{tsi?.curve.extrapolated ? ' · Fig 2 extrapolated beyond FRC 3 to 3.5 L' : ''}
        {personal.hr ? ` · HR curve ${personal.hr.label}` : ''}
      </div>
    </div>
  )
}
