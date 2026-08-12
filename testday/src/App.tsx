import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dashboard } from './ui/Dashboard'
import { Builder } from './ui/Builder'
import { Analysis } from './ui/Analysis'
import { SensorPanel } from './ui/SensorPanel'
import { Settings } from './ui/Settings'
import { SensorManager } from './ble/manager'
import { DEFAULT_ATHLETE, newId, type Athlete, type Protocol } from './model/protocol'
import { builtInProtocols } from './model/presets'
import { TestRunner } from './model/session'
import { mmpCurve } from './model/metrics'
import {
  deleteProtocol,
  listProtocols,
  listSessions,
  loadSettings,
  saveProtocol,
  saveSession,
  saveSettings,
  type Settings as SettingsShape,
} from './model/storage'

type View = 'run' | 'protocols' | 'analysis' | 'settings'

const AUTOSAVE_MS = 15000

const DEFAULT_SETTINGS: SettingsShape = {
  athlete: DEFAULT_ATHLETE,
  wheelCircumferenceM: 2.096,
}

export default function App() {
  const managerRef = useRef<SensorManager>(null)
  managerRef.current ??= new SensorManager()
  const manager = managerRef.current

  const [settings, setSettings] = useState<SettingsShape>(() => loadSettings(DEFAULT_SETTINGS))
  const [saved, setSaved] = useState<Protocol[]>([])
  const [view, setView] = useState<View>('run')
  const [sensorsOpen, setSensorsOpen] = useState(false)
  const [activeProtocol, setActiveProtocol] = useState<Protocol | null>(null)
  const [runner, setRunner] = useState<TestRunner | null>(null)
  const [sessionId, setSessionId] = useState<string>(() => newId('session'))
  const [bestCurve, setBestCurve] = useState<{ durationS: number; watts: number }[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const protocols = useMemo(
    () => [...saved, ...builtInProtocols(settings.athlete.ftpWatts)],
    [saved, settings.athlete.ftpWatts],
  )

  useEffect(() => {
    saveSettings(settings)
    manager.setWheelCircumference(settings.wheelCircumferenceM)
  }, [settings, manager])

  useEffect(() => {
    void listProtocols().then(setSaved)
    // The all-time best curve gives the live MMP panel something to beat.
    void listSessions().then((sessions) => {
      const best = new Map<number, number>()
      for (const session of sessions) {
        for (const point of mmpCurve(session.samples.map((s) => s.power ?? 0))) {
          const current = best.get(point.durationS)
          if (current === undefined || point.watts > current) best.set(point.durationS, point.watts)
        }
      }
      setBestCurve(
        [...best.entries()].map(([durationS, watts]) => ({ durationS, watts })).sort((a, b) => a.durationS - b.durationS),
      )
    })
  }, [])

  // Restore the last protocol so a reload during a test day lands where it left off.
  useEffect(() => {
    if (activeProtocol || protocols.length === 0) return
    const remembered = protocols.find((p) => p.id === settings.lastProtocolId)
    setActiveProtocol(remembered ?? protocols[protocols.length - 1])
  }, [protocols, activeProtocol, settings.lastProtocolId])

  /** A runner is bound to one protocol and one athlete; changing either rebuilds it. */
  useEffect(() => {
    if (!activeProtocol) return
    const next = new TestRunner({
      protocol: activeProtocol,
      athlete: settings.athlete,
      readMetrics: () => manager.read(),
      machine: () => manager.machine?.control ?? null,
    })
    setRunner((previous) => {
      previous?.dispose()
      return next
    })
    setSessionId(newId('session'))
    return () => next.dispose()
  }, [activeProtocol, settings.athlete, manager])

  const persist = useCallback(
    async (current: TestRunner, id: string) => {
      if (current.recordedSamples.length === 0) return
      await saveSession(current.toRecord(id))
    },
    [],
  )

  // Autosave, so a browser crash mid-test costs at most one interval.
  useEffect(() => {
    if (!runner) return
    const timer = setInterval(() => void persist(runner, sessionId), AUTOSAVE_MS)
    return () => clearInterval(timer)
  }, [runner, sessionId, persist])

  const finish = async () => {
    if (!runner) return
    runner.finish()
    if (runner.recordedSamples.length === 0) {
      setToast('Nothing recorded — session not saved.')
      return
    }
    await persist(runner, sessionId)
    setToast('Session saved.')
    setView('analysis')
  }

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const selectProtocol = (protocol: Protocol) => {
    setActiveProtocol(protocol)
    setSettings((s) => ({ ...s, lastProtocolId: protocol.id }))
  }

  return (
    <div className="app">
      <nav className="tabs">
        <button className={view === 'run' ? 'on' : ''} onClick={() => setView('run')}>
          Run
        </button>
        <button className={view === 'protocols' ? 'on' : ''} onClick={() => setView('protocols')}>
          Protocols
        </button>
        <button className={view === 'analysis' ? 'on' : ''} onClick={() => setView('analysis')}>
          Analysis
        </button>
        <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>
          Settings
        </button>
        <span className="spacer" />
        <span className="muted small">{activeProtocol?.name}</span>
      </nav>

      {view === 'run' &&
        (runner && activeProtocol ? (
          <Dashboard
            runner={runner}
            protocol={activeProtocol}
            athlete={settings.athlete}
            manager={manager}
            bestCurve={bestCurve}
            onOpenSensors={() => setSensorsOpen(true)}
            onFinish={finish}
          />
        ) : (
          <div className="empty">Pick a protocol to run.</div>
        ))}

      {view === 'protocols' && (
        <Builder
          protocols={protocols}
          selectedId={activeProtocol?.id ?? null}
          athlete={settings.athlete}
          onSelect={selectProtocol}
          onSave={async (protocol) => {
            await saveProtocol(protocol)
            setSaved(await listProtocols())
            selectProtocol(protocol)
          }}
          onDelete={async (id) => {
            await deleteProtocol(id)
            setSaved(await listProtocols())
          }}
          onRun={(protocol) => {
            selectProtocol(protocol)
            setView('run')
          }}
        />
      )}

      {view === 'analysis' && <Analysis protocols={protocols} />}

      {view === 'settings' && (
        <Settings
          settings={settings}
          onChange={setSettings}
          onResetAthlete={() => setSettings((s) => ({ ...s, athlete: DEFAULT_ATHLETE as Athlete }))}
        />
      )}

      {sensorsOpen && (
        <SensorPanel manager={manager} ftpWatts={settings.athlete.ftpWatts} onClose={() => setSensorsOpen(false)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
