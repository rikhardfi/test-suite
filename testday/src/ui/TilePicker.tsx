import { useState } from 'react'
import { defaultFrontFor, tilesForSport } from './tiles'
import type { Sport } from '../model/protocol'
import { Modal } from './Modal'

/**
 * Chooses which tiles the front face shows, and in what order.
 *
 * The back face always shows everything, so nothing is ever hidden by this;
 * it only decides what is worth a glance during a test. Order matters, because
 * the first few are the ones read from across a room.
 */
export function TilePicker({
  sport,
  selected,
  onChange,
  onClose,
}: {
  sport: Sport
  selected: string[]
  onChange: (keys: string[]) => void
  onClose: () => void
}) {
  const available = tilesForSport(sport)
  const [keys, setKeys] = useState<string[]>(
    selected.length ? selected.filter((k) => available.some((t) => t.key === k)) : defaultFrontFor(sport),
  )

  const toggle = (key: string) =>
    setKeys((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    )

  const move = (key: string, by: number) =>
    setKeys((current) => {
      const from = current.indexOf(key)
      const to = from + by
      if (from < 0 || to < 0 || to >= current.length) return current
      const next = [...current]
      next.splice(to, 0, ...next.splice(from, 1))
      return next
    })

  return (
    <Modal onClose={onClose} className="wide">
        <h2>Dashboard tiles</h2>
        <p className="muted small">
          These appear on the front face, in this order. The flip side always shows everything the
          app can compute, so nothing chosen here is the only way to see a number.
        </p>

        <div className="tile-picker">
          <div>
            <h3>Showing</h3>
            <ol className="picked">
              {keys.map((key, index) => {
                const tile = available.find((t) => t.key === key)
                if (!tile) return null
                return (
                  <li key={key}>
                    <span className="grow">{tile.label}</span>
                    <button
                      className="ghost small"
                      disabled={index === 0}
                      onClick={() => move(key, -1)}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      className="ghost small"
                      disabled={index === keys.length - 1}
                      onClick={() => move(key, 1)}
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button className="ghost small" onClick={() => toggle(key)}>
                      Remove
                    </button>
                  </li>
                )
              })}
              {keys.length === 0 && <li className="muted small">Nothing selected.</li>}
            </ol>
          </div>

          <div>
            <h3>Available</h3>
            <ul className="available">
              {available.map((tile) => (
                <li key={tile.key}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={keys.includes(tile.key)}
                      onChange={() => toggle(tile.key)}
                    />
                    <span>
                      <strong>{tile.label}</strong>
                      <span className="muted small block">{tile.about}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={() => setKeys(defaultFrontFor(sport))}>
            Reset to defaults
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => {
              onChange(keys)
              onClose()
            }}
          >
            Save
          </button>
        </div>
    </Modal>
  )
}
