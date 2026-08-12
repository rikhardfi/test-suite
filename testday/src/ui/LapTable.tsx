import { useEffect, useRef } from 'react'
import { formatClock, formatCountdown } from '../model/metrics'
import { stepLabel, type Athlete, type Protocol } from '../model/protocol'
import type { Lap, RunnerState } from '../model/session'

interface Props {
  laps: Lap[]
  protocol: Protocol
  athlete: Athlete
  activeIndex: number
  state: RunnerState
  phaseRemainingS: number
  onJump: (index: number) => void
  onLactate: (index: number) => void
}

/** Step list with the active row pinned in view, matching a lap display. */
export function LapTable({
  laps,
  protocol,
  athlete,
  activeIndex,
  state,
  phaseRemainingS,
  onJump,
  onLactate,
}: Props) {
  const activeRef = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className="table-scroll">
      <table className="laps">
        <thead>
          <tr>
            <th>Lap</th>
            <th>Time</th>
            <th>Target</th>
            <th>Avg</th>
            <th>HR</th>
            <th>La</th>
            <th>Left</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap, index) => {
            const step = protocol.steps[index]
            const isActive = index === activeIndex && state !== 'finished'
            const isDone = index < activeIndex || state === 'finished'
            return (
              <tr
                key={step?.id ?? index}
                ref={isActive ? activeRef : undefined}
                className={isActive ? 'active' : isDone ? 'done' : ''}
                onDoubleClick={() => onJump(index)}
                title="Double-click to jump to this step"
              >
                <td className="name">{lap.name}</td>
                <td>{formatClock(lap.durationS)}</td>
                <td>{step ? stepLabel(step, athlete.ftpWatts) : '—'}</td>
                <td>{lap.avgPower != null ? `${lap.avgPower} W` : '—'}</td>
                <td>{lap.avgHeartRate ?? '—'}</td>
                <td>
                  <button className="cell-button" onClick={() => onLactate(index)}>
                    {lap.lactate != null ? lap.lactate.toFixed(1) : '+'}
                  </button>
                </td>
                <td className="right">
                  {isActive ? formatCountdown(phaseRemainingS) : isDone ? 'Done' : formatClock(lap.durationS)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
