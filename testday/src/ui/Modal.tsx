import { useRef, type ReactNode } from 'react'

/**
 * A dialog that closes on the backdrop, and only when the click really was on
 * the backdrop.
 *
 * The obvious version, `<div className="backdrop" onClick={close}>` with
 * `stopPropagation` on the panel, has a bug that bites constantly and looks
 * like a glitch: a `click` event fires on the nearest common ancestor of where
 * the mouse went down and where it came up. Select text in a field, drag
 * slightly past the edge of the dialog, release, and the common ancestor is the
 * backdrop. The dialog closes and the draft goes with it.
 *
 * That is how the protocol editor lost work, and the same pattern was live on
 * the lactate dialog, where it costs a blood value in the middle of a test.
 *
 * The fix is to require both ends of the gesture to be on the backdrop.
 */
export function Modal({
  children,
  onClose,
  className = '',
  as = 'div',
  onSubmit,
}: {
  children: ReactNode
  onClose: () => void
  /** Extra classes on the panel, e.g. `narrow` or `wide`. */
  className?: string
  /** `form` when the panel submits, so Enter works the way it should. */
  as?: 'div' | 'form'
  onSubmit?: (event: React.FormEvent) => void
}) {
  const downOnBackdrop = useRef(false)

  const Panel = as as 'div'

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // Both ends of the gesture have to have been out here. A drag that
        // started inside the panel is not a click on the backdrop, whatever the
        // click event's target says.
        if (event.target === event.currentTarget && downOnBackdrop.current) onClose()
        downOnBackdrop.current = false
      }}
    >
      <Panel
        className={`modal ${className}`.trim()}
        onSubmit={onSubmit as never}
        onMouseDown={(event: React.MouseEvent) => event.stopPropagation()}
      >
        {children}
      </Panel>
    </div>
  )
}
