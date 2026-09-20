import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AthleteScreen } from './ui/AthleteScreen'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { isAthleteWindow } from './ui/athleteLink'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

/**
 * The last boundary. Individual panels have their own, so reaching this one
 * means something outside a panel failed and there is no partial interface left
 * to keep running.
 *
 * Reloading is safe and is the right offer to make: the recording lives in the
 * main process, so it is still open and still being written, and the reloaded
 * interface will find the session and offer it straight back.
 */
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      label="testday"
      fallback={(error) => (
        <div className="app-error">
          <h1>testday stopped drawing.</h1>
          <p className="muted">{error.message}</p>
          <p className="muted small">
            If a session was recording, it is still open in the recording process and everything
            captured so far is on disk. Reloading brings the interface back and offers the session
            for resume.
          </p>
          <button className="primary" onClick={() => window.location.reload()}>
            Reload the interface
          </button>
        </div>
      )}
    >
      {/* The athlete window only displays: no sensors, no runner, no recorder. */}
      {isAthleteWindow() ? <AthleteScreen /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
)
