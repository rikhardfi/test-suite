import { useEffect, useState } from 'react'

/**
 * Number and duration inputs that can actually be typed into.
 *
 * The obvious controlled numeric input, `value={n}` with
 * `onChange={e => set(Number(e.target.value))}`, cannot be cleared. Select the
 * contents, delete, and `Number('')` is 0, which renders straight back as "0".
 * Type 5 after it and the field reads "05". The zero sticks and there is no
 * keystroke that removes it.
 *
 * The fix is to hold what was typed as text and convert only when it parses.
 * The field is then a string the whole time it is being edited, which is what
 * it actually is, and an empty field stays empty.
 */

function useDraft(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value)
  const [lastExternal, setLastExternal] = useState(value)

  // Follow the value when it changes from outside, without fighting the
  // keystrokes: a re-render caused by typing must not reset what was typed.
  useEffect(() => {
    if (value !== lastExternal) {
      setLastExternal(value)
      setDraft(value)
    }
  }, [value, lastExternal])

  return [draft, setDraft]
}

export function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  suffix,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
}) {
  const [draft, setDraft] = useDraft(formatNumber(value))

  const commit = (text: string) => {
    setDraft(text)
    const parsed = parseNumber(text)
    // An empty or half-typed field is a state the input is allowed to be in.
    // Nothing is pushed upward until it means something, so a partially typed
    // "1." or "-" does not become a value.
    if (parsed === null) return
    const clamped = clamp(parsed, min, max)
    if (clamped !== value) onChange(clamped)
  }

  return (
    <label>
      {label}
      <span className="input-with-suffix">
        <input
          inputMode="decimal"
          value={draft}
          step={step ?? 1}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            // On leaving, snap the text back to the committed value, so a field
            // left empty or mid-edit does not sit there looking like a value.
            const parsed = parseNumber(draft)
            setDraft(formatNumber(parsed === null ? value : clamp(parsed, min, max)))
          }}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  )
}

/**
 * A duration typed the way people say it: "4:30", not 270.
 *
 * Plain seconds is fine for a computer and wrong for the person setting up a
 * four-and-a-half minute interval, who has to do the arithmetic every time and
 * gets it wrong once per test day.
 */
export function DurationField({
  label,
  seconds,
  onChange,
  hint,
}: {
  label: string
  seconds: number
  onChange: (seconds: number) => void
  hint?: string
}) {
  const [draft, setDraft] = useDraft(formatDuration(seconds))
  const parsed = parseDuration(draft)

  return (
    <label>
      {label}
      <input
        inputMode="numeric"
        placeholder="4:30"
        value={draft}
        className={draft.trim() && parsed === null ? 'invalid' : ''}
        onChange={(e) => {
          setDraft(e.target.value)
          const next = parseDuration(e.target.value)
          if (next !== null && next !== seconds) onChange(next)
        }}
        onBlur={() => setDraft(formatDuration(parseDuration(draft) ?? seconds))}
      />
      <span className="muted small">
        {draft.trim() && parsed === null ? 'Type mm:ss, or seconds' : (hint ?? `${seconds} s`)}
      </span>
    </label>
  )
}

/**
 * The same behaviour without a label, for a table cell.
 *
 * `allowEmpty` is for a field where blank genuinely means something other than
 * a number, such as "inherit the protocol's setting". Elsewhere blank is a
 * transient editing state and the previous value stands.
 */
export function NumberCell({
  value,
  onChange,
  onClear,
  step,
  min,
  max,
  className,
}: {
  value: number | null
  onChange: (value: number) => void
  /** Called when the field is emptied, for a field where blank means something. */
  onClear?: () => void
  step?: number
  min?: number
  max?: number
  className?: string
}) {
  const [draft, setDraft] = useDraft(value == null ? '' : formatNumber(value))
  const allowEmpty = onClear !== undefined

  return (
    <input
      inputMode="decimal"
      className={className}
      step={step ?? 1}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const parsed = parseNumber(e.target.value)
        if (parsed === null) {
          if (allowEmpty && e.target.value.trim() === '') onClear?.()
          return
        }
        onChange(clamp(parsed, min, max))
      }}
      onBlur={() => {
        const parsed = parseNumber(draft)
        if (parsed === null) {
          setDraft(allowEmpty && draft.trim() === '' ? '' : value == null ? '' : formatNumber(value))
          return
        }
        setDraft(formatNumber(clamp(parsed, min, max)))
      }}
    />
  )
}

/** A duration cell, for the step table where there is no room for a label. */
export function DurationCell({
  seconds,
  onChange,
}: {
  seconds: number
  onChange: (seconds: number) => void
}) {
  const [draft, setDraft] = useDraft(formatDuration(seconds))
  const invalid = draft.trim() !== '' && parseDuration(draft) === null

  return (
    <input
      inputMode="numeric"
      className={invalid ? 'invalid' : ''}
      title="mm:ss, or plain seconds"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const next = parseDuration(e.target.value)
        if (next !== null && next !== seconds) onChange(next)
      }}
      onBlur={() => setDraft(formatDuration(parseDuration(draft) ?? seconds))}
    />
  )
}

// --- parsing ---------------------------------------------------------------

/** Null while the text is empty or half-typed, which are not values. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const clamp = (value: number, min?: number, max?: number): number => {
  if (min != null && value < min) return min
  if (max != null && value > max) return max
  return value
}

/** Trailing zeros and a trailing point are noise once the field is left. */
export const formatNumber = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(4))) : ''

/**
 * "4:30" is 270 s, "90" is 90 s, "1:02:03" is an hour and change.
 *
 * A bare number is read as seconds rather than minutes: it is what the field
 * held before this existed, and silently reinterpreting every saved protocol as
 * sixty times longer would be a much worse bug than the one being fixed.
 */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!/^\d+(:\d{1,2}){0,2}$/.test(trimmed)) return null

  const parts = trimmed.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  // Only the leading part may exceed 59: "90:00" is a legitimate ninety minutes.
  if (parts.slice(1).some((n) => n > 59)) return null

  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const mm = String(minutes).padStart(hours ? 2 : 1, '0')
  return hours
    ? `${hours}:${mm}:${String(rest).padStart(2, '0')}`
    : `${mm}:${String(rest).padStart(2, '0')}`
}
