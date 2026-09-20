import { useMemo } from 'react'
import { Tile } from './Dashboard'
import { ErrorBoundary } from './ErrorBoundary'
import { WorkoutGraph } from './WorkoutGraph'
import { useAthleteFrames } from './athleteLink'
import { useFullscreen } from './hooks'
import { defaultFrontFor, tileByKey, type TileContext } from './tiles'
import { formatCountdown } from '../model/metrics'

/**
 * What the athlete looks at: the operator's numbers, large, and the plan with
 * the cursor on it. Nothing here can be pressed except full screen, because
 * nothing on this screen should be able to change the test.
 */
export function AthleteScreen() {
  const frames = useAthleteFrames()
  const [fullscreen, toggleFullscreen] = useFullscreen()

  const tiles = useMemo(() => {
    if (!frames) return []
    const { view, samples } = frames
    const context: TileContext = { ...view, samples }
    const keys = view.tiles.length ? view.tiles : defaultFrontFor(view.protocol.sport)
    return keys
      .map((key) => tileByKey(key))
      .filter((tile): tile is NonNullable<typeof tile> => !!tile)
      .filter((tile) => !tile.sport || tile.sport === view.protocol.sport)
      .map((tile) => ({ tile, value: tile.compute(context) }))
  }, [frames])

  if (!frames) {
    return (
      <div className="athlete-screen">
        <div className="empty">
          Waiting for the operator window. Pick a protocol to run there and this screen follows it.
        </div>
      </div>
    )
  }

  const { view, samples } = frames
  const { snapshot } = view

  return (
    <div className="athlete-screen">
      <header className="athlete-head">
        <strong>{snapshot.step?.name ?? view.protocol.name}</strong>
        <span className="muted">
          {snapshot.phase === 'break' ? 'sample break · ' : ''}
          {formatCountdown(snapshot.phaseRemainingS)} left
        </span>
        <span className="spacer" />
        {!fullscreen && (
          <button className="ghost small" onClick={toggleFullscreen}>
            Full screen
          </button>
        )}
      </header>
      <div className="tiles athlete-tiles">
        {tiles.map(({ tile, value }) => (
          <Tile
            key={tile.key}
            label={tile.label}
            value={value ? value.value : '—'}
            unit={value?.unit}
            note={value?.note}
            tone={tile.tone}
            wide={tile.wide}
            suspect={value?.suspect}
            waiting={value === null}
          />
        ))}
      </div>
      <section className="panel athlete-graph">
        <ErrorBoundary label="Workout graph">
          <WorkoutGraph
            protocol={view.protocol}
            athlete={view.athlete}
            samples={samples}
            elapsedS={snapshot.elapsedS}
            fitY={view.fitY}
          />
        </ErrorBoundary>
      </section>
    </div>
  )
}
