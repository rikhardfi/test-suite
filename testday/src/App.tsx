import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dashboard } from './ui/Dashboard'
import { Builder } from './ui/Builder'
import { Analysis } from './ui/Analysis'
import { Longitudinal } from './ui/Longitudinal'
import { SensorPanel } from './ui/SensorPanel'
import { TilePicker } from './ui/TilePicker'
import { EnvironmentForm } from './ui/EnvironmentForm'
import { Settings } from './ui/Settings'
import { SensorManager } from './ble/manager'
import { FLOW_METER_ID } from './ble/flowMeter'
import { DEFAULT_ATHLETE, newId, type Athlete, type Protocol } from './model/protocol'
import { builtInProtocols } from './model/presets'
import { protocolDurationS } from './model/protocol'
import { TestRunner, type Environment, type SessionRecord } from './model/session'
import { PowerMatch, ReferenceWatch } from './model/powermatch'
import { describeProbe, runErgProbe, type TrainerResponse } from './ble/probe'
import { formatClock, mmpCurve } from './model/metrics'
import { createRecorder, isDesktop } from './model/recorder.create'
import { IDLE_STATUS, headerFor, type RecorderStatus } from './model/recorder'
import type { SessionSummary } from './model/journal'
import {
  applySettings,
  deleteProtocol,
  ensureParticipantSalt,
  importLegacyProtocols,
  listProtocols,
  listSessions,
  loadSettings,
  loadStoredSettings,
  saveProtocol,
  saveSettings,
  type Settings as SettingsShape,
} from './model/storage'

type View = 'run' | 'protocols' | 'analysis' | 'settings'

/** Sessions read back to build the all-time best curve. Enough to be useful, bounded so a long-lived machine does not read every journal at boot. */
const BEST_CURVE_SESSIONS = 20

const MIGRATION_KEY = 'testday.migrated.v1'

/**
 * Its own marker, deliberately: the sessions rescue above may already have run
 * on this origin, and protocols still need collecting from it.
 */
const PROTOCOL_MIGRATION_KEY = 'testday.migrated.protocols.v1'

const DEFAULT_SETTINGS: SettingsShape = {
  athlete: DEFAULT_ATHLETE,
  wheelCircumferenceM: 2.096,
}

interface ResumeRequest {
  session: SessionRecord
  protocolId: string
  /** Protocol seconds left after the last recorded sample. */
  remainingS: number
}

export default function App() {
  const managerRef = useRef<SensorManager>(null)
  managerRef.current ??= new SensorManager()
  const manager = managerRef.current

  const recorderRef = useRef<ReturnType<typeof createRecorder>>(null)
  recorderRef.current ??= createRecorder()
  const recorder = recorderRef.current

  const [settings, setSettings] = useState<SettingsShape>(() =>
    ensureParticipantSalt(loadSettings(DEFAULT_SETTINGS)),
  )
  /**
   * Settings boot from this origin's localStorage and are then corrected from
   * the copy the desktop app keeps as a file. Nothing is written back until
   * that has happened, or the defaults would overwrite the record.
   */
  const [hydrated, setHydrated] = useState(false)
  const [saved, setSaved] = useState<Protocol[]>([])
  const [view, setView] = useState<View>('run')
  const [sensorsOpen, setSensorsOpen] = useState(false)
  const [tilesOpen, setTilesOpen] = useState(false)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  /** The latest conditions anybody typed, for the form to reopen on and the tile to show. */
  const [conditions, setConditions] = useState<Environment | null>(null)
  /**
   * Conditions entered before Start. There is no recording to put them in yet,
   * and the room is usually measured while the athlete is still warming up, so
   * they wait here and go in at the head of the journal when it opens.
   */
  const heldConditions = useRef<Environment[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [activeProtocol, setActiveProtocol] = useState<Protocol | null>(null)
  const [runner, setRunner] = useState<TestRunner | null>(null)
  /**
   * The power correction and the probe that calibrated it.
   *
   * One instance for the life of the app rather than one per runner: the
   * multiplier is measured in the warm-up, which happens before a protocol is
   * necessarily settled on, and it is a property of the equipment rather than
   * of the test.
   */
  const powerMatchRef = useRef(new PowerMatch())
  const referenceWatchRef = useRef(new ReferenceWatch())
  const [probe, setProbe] = useState<TrainerResponse | null>(null)
  const [probing, setProbing] = useState(false)
  const [bestCurve, setBestCurve] = useState<{ durationS: number; watts: number }[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [status, setStatus] = useState<RecorderStatus>(IDLE_STATUS)
  const [interrupted, setInterrupted] = useState<SessionSummary[]>([])
  const [resumeRequest, setResumeRequest] = useState<ResumeRequest | null>(null)

  const protocols = useMemo(
    () => [...saved, ...builtInProtocols(settings.athlete.ftpWatts)],
    [saved, settings.athlete.ftpWatts],
  )

  useEffect(() => {
    let cancelled = false
    void loadStoredSettings().then((stored) => {
      if (cancelled) return
      if (stored) setSettings((s) => ensureParticipantSalt(applySettings(s, stored)))
      setHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (hydrated) saveSettings(settings)
    manager.setWheelCircumference(settings.wheelCircumferenceM)
  }, [settings, hydrated, manager])

  useEffect(() => recorder.onStatus(setStatus), [recorder])

  /**
   * Sensors are remembered between runs: which ones were paired, and which
   * metric each was assigned to. Reconnection is offered rather than done
   * silently, and only for devices the browser has already been granted access
   * to, so nothing here can reach hardware the operator never approved.
   */
  useEffect(() => {
    manager.restorePreferences(settings.sensors?.preferred ?? {})
    manager.onPreferencesChanged = (preferred) =>
      setSettings((s) => ({ ...s, sensors: { ...s.sensors, preferred } }))
    return () => {
      manager.onPreferencesChanged = undefined
    }
    // Restored once, from what was on disk at boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager])

  // Keep the paired list current, so the next launch has something to offer.
  useEffect(() => {
    const known = manager.knownDevices
    if (known.length === 0) return
    setSettings((s) =>
      JSON.stringify(s.sensors?.known) === JSON.stringify(known)
        ? s
        : { ...s, sensors: { ...s.sensors, known } },
    )
  }, [manager, status.recording])

  const reconnectSensors = useCallback(async () => {
    const known = settings.sensors?.known ?? []
    if (known.length === 0) return
    const count = await manager.reconnectKnown(known)
    setToast(
      count > 0
        ? `Reconnected ${count} sensor(s) from last time.`
        : 'None of the remembered sensors answered. Pair them from the sensor panel.',
    )
  }, [manager, settings.sensors?.known])

  // A dropped sensor is chased indefinitely while a test is running, and only
  // for a bounded number of attempts when nothing is being recorded.
  useEffect(() => {
    manager.setRecording(status.recording)
  }, [status.recording, manager])

  /**
   * The native-rate stream. Every decoded notification goes to disk as it
   * arrives, timestamped on the session clock so it stays alignable with the
   * 1 Hz samples, alongside beat-to-beat intervals and any change in which
   * device owns a metric.
   *
   * Subscribed only while a recording is open: outside one there is no journal
   * to append to, and the sensor panel is chatty.
   */
  useEffect(() => {
    if (!status.recording || !runner) return
    const stopMetrics = manager.onMetric((deviceId, update) => {
      // The flow meter's updates are a quarter-second summary for the tiles;
      // its measurement is written in full to flow.ndjson by the recorder.
      if (deviceId === FLOW_METER_ID) return
      const { rrIntervalsMs, ...values } = update
      const t = Number(runner.elapsed.toFixed(2))
      if (Object.keys(values).length > 0) recorder.raw(deviceId, t, values)
      if (rrIntervalsMs?.length) recorder.rr(t, rrIntervalsMs)
    })
    /**
     * Environment readings go to their own slow channel rather than into the
     * 1 Hz stream. A monitor that measures every five minutes would otherwise
     * contribute 299 carried-forward values and one measurement per reading,
     * and nothing downstream could tell them apart.
     */
    const stopEnvironment = manager.onMetric((_deviceId, update) => {
      const reading = {
        tempC: update.ambientTempC,
        humidityPct: update.humidityPct,
        co2Ppm: update.co2Ppm,
        pressureHpa: update.pressureHpa,
      }
      if (Object.values(reading).every((v) => v == null)) return
      recorder.environment(Number(runner.elapsed.toFixed(2)), { ...reading, source: 'sensor' })
    })
    const stopSources = manager.onSourceChange((changes) => {
      for (const change of changes) {
        recorder.event('sourceChanged', {
          metric: change.metric,
          from: change.from ?? '',
          to: change.to ?? '',
          name: change.toName ?? '',
        })
      }
    })
    return () => {
      stopMetrics()
      stopEnvironment()
      stopSources()
    }
  }, [status.recording, runner, manager, recorder])

  /**
   * Who is measuring what, written once as the session opens.
   *
   * The gate for this feature warns rather than blocks, which puts the weight
   * here: a warning that only ever appeared on screen at the start is no
   * warning at all a year later. Reference and machine identities, the
   * correction in force, and every doubt about the meter go into the journal
   * where the report can find them.
   */
  const recordPowerSources = useCallback(() => {
    const pair = manager.powerPair()
    const match = powerMatchRef.current
    const verdict = referenceWatchRef.current.verdict({
      hasSeparateReference: pair.machine != null,
      // Item 5 of the improvements list. Until it exists there is no zero
      // offset to point at, and saying so is better than implying there was.
      hasZeroOffset: false,
    })
    recorder.event('powerSources', {
      reference: pair.reference?.name ?? '',
      referenceId: pair.reference?.id ?? '',
      machine: pair.machine?.name ?? '',
      machineId: pair.machine?.id ?? '',
      correcting: settings.powerMatch?.enabled === true,
      calibrated: match.isCalibrated,
      factor: Number(match.factor.toFixed(4)),
      sidedness: verdict.sidedness,
      warnings: verdict.warnings.join(' | '),
    })
  }, [manager, recorder, settings.powerMatch?.enabled])

  /**
   * Thirty seconds that answer whether the trainer is listening and by how much
   * it lies. Run from the sensor panel, in the warm-up, before it matters.
   */
  const probeErg = useCallback(async () => {
    const control = manager.machine?.control
    if (!control) {
      setToast('No controllable machine is connected.')
      return
    }
    setProbing(true)
    try {
      const result = await runErgProbe({
        control,
        read: () => {
          const pair = manager.powerPair()
          return {
            referenceW: pair.reference?.watts,
            machineW: pair.machine?.watts,
          }
        },
      })
      setProbe(result)
      if (result.ok && result.multiplier != null) {
        powerMatchRef.current.calibrate(result.multiplier, 0, 'probe')
      }
      setToast(describeProbe(result))
    } catch (error) {
      setToast(`ERG probe failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setProbing(false)
      // The probe leaves the machine holding its last set-point; put it back.
      void control.stop().catch(() => undefined)
    }
  }, [manager])

  /**
   * Whether the reference meter measures one leg or two, watched continuously.
   *
   * Bluetooth will not answer that directly. What it reports is pedal balance,
   * and a meter that halves one leg and doubles it again reports exactly 50.0
   * forever. Watched outside a recording as well as inside one, because the
   * answer belongs to the device rather than to the session.
   */
  useEffect(() => {
    return manager.onMetric((_deviceId, update) => {
      if (update.pedalBalancePct != null) {
        referenceWatchRef.current.observe(update.pedalBalancePct)
      }
    })
  }, [manager])

  useEffect(() => {
    void listProtocols().then(setSaved)
  }, [])

  // The all-time best curve gives the live MMP panel something to beat.
  const refreshBestCurve = useCallback(async () => {
    const summaries = await recorder.list()
    const best = new Map<number, number>()
    for (const summary of summaries.slice(0, BEST_CURVE_SESSIONS)) {
      const session = await recorder.read(summary.id)
      if (!session) continue
      for (const point of mmpCurve(session.samples.map((s) => s.power ?? 0))) {
        const current = best.get(point.durationS)
        if (current === undefined || point.watts > current) best.set(point.durationS, point.watts)
      }
    }
    setBestCurve(
      [...best.entries()]
        .map(([durationS, watts]) => ({ durationS, watts }))
        .sort((a, b) => a.durationS - b.durationS),
    )
  }, [recorder])

  /**
   * One-time rescue of anything recorded in the browser before this machine had
   * the desktop app, so no session is stranded in IndexedDB.
   */
  useEffect(() => {
    if (!isDesktop()) return
    if (localStorage.getItem(MIGRATION_KEY)) return
    void (async () => {
      try {
        const legacy = await listSessions()
        if (legacy.length > 0) {
          const imported = await window.testday!.importSessions(legacy)
          if (imported > 0) setToast(`Imported ${imported} session(s) recorded in the browser.`)
        }
      } finally {
        localStorage.setItem(MIGRATION_KEY, '1')
      }
    })()
  }, [])

  /**
   * The same rescue for protocols, which used to live in the same per-origin
   * store and disappeared from view the moment the app was run a different way.
   * Kept separate from the session rescue above so that a machine which has
   * already done that one still collects its protocols.
   */
  useEffect(() => {
    if (!isDesktop()) return
    if (localStorage.getItem(PROTOCOL_MIGRATION_KEY)) return
    void (async () => {
      try {
        const imported = await importLegacyProtocols()
        if (imported > 0) {
          setSaved(await listProtocols())
          setToast(`Recovered ${imported} protocol(s) saved before protocols became files.`)
        }
      } finally {
        localStorage.setItem(PROTOCOL_MIGRATION_KEY, '1')
      }
    })()
  }, [])

  // Anything the recorder never closed was interrupted, and is offered back.
  const refreshInterrupted = useCallback(async () => {
    const open = await recorder.unclosed()
    setInterrupted(open.filter((summary) => summary.sampleCount > 0))
  }, [recorder])

  useEffect(() => {
    void refreshInterrupted()
    void refreshBestCurve()
  }, [refreshInterrupted, refreshBestCurve])

  // Restore the last protocol so a reload during a test day lands where it left off.
  useEffect(() => {
    if (activeProtocol || protocols.length === 0) return
    const remembered = protocols.find((p) => p.id === settings.lastProtocolId)
    setActiveProtocol(remembered ?? protocols[protocols.length - 1])
  }, [protocols, activeProtocol, settings.lastProtocolId])

  /** A runner is bound to one protocol and one athlete; changing either rebuilds it. */
  useEffect(() => {
    if (!activeProtocol) return
    const id = newId('session')
    const next = new TestRunner({
      protocol: activeProtocol,
      athlete: settings.athlete,
      readMetrics: () => manager.read(),
      machine: () => manager.machine?.control ?? null,
      onStart: (startedAt) => {
        void recorder
          .begin(headerFor(id, activeProtocol, settings.athlete, startedAt))
          .then(() => {
            for (const { at, ...reading } of heldConditions.current.splice(0)) {
              recorder.environment(0, reading, at)
            }
            recordPowerSources()
          })
          .catch((error: unknown) =>
            setToast(`Recording did not start: ${error instanceof Error ? error.message : String(error)}`),
          )
      },
      onSample: (sample) => recorder.sample(sample),
      onLactate: (entry) => recorder.lactate(entry),
      onEvent: (kind, data) => recorder.event(kind, data),
      // Off unless the operator has said the reference meter is worth
      // believing. With it off the raw protocol target is commanded, which is
      // what every session before this one did.
      powerMatch: settings.powerMatch?.enabled ? powerMatchRef.current : undefined,
    })
    setRunner((previous) => {
      previous?.dispose()
      return next
    })
    return () => next.dispose()
  }, [activeProtocol, settings.athlete, manager, recorder])

  /**
   * Seeds a rebuilt runner with a session recovered from disk. Runs after the
   * effect above, so the runner it seeds is the one built for this protocol.
   */
  useEffect(() => {
    if (!resumeRequest || !runner || !activeProtocol) return
    if (activeProtocol.id !== resumeRequest.protocolId) return
    runner.resumeFrom(resumeRequest.session)
    const { remainingS } = resumeRequest
    setResumeRequest(null)
    setView('run')
    setToast(
      remainingS > 0
        ? `Session restored, paused with ${formatClock(remainingS)} of the protocol left. Start when the athlete is ready.`
        : 'Session restored, but the protocol already ran to the end. Jump to a step in the lap table to record more into it.',
    )
  }, [resumeRequest, runner, activeProtocol])

  /**
   * Reopens a session for recording: interrupted or finished, from the banner or
   * from the analysis list. A finished one gets an explicit reopen record in its
   * journal, so its earlier close record stops describing its current state.
   */
  const resumeSession = async (summary: Pick<SessionSummary, 'id' | 'protocolName'>) => {
    const state = await recorder.resume(summary.id)
    if (!state) {
      setToast('That session could not be reopened.')
      return
    }
    // The journal header carries the protocol it was recorded against.
    const protocol = protocols.find((p) => p.id === state.session.protocolId) ?? null
    if (!protocol) {
      setToast(`The protocol for that session ("${summary.protocolName}") no longer exists.`)
      return
    }
    setInterrupted((all) => all.filter((s) => s.id !== summary.id))
    setActiveProtocol(protocol)
    setSettings((s) => ({ ...s, lastProtocolId: protocol.id }))
    setResumeRequest({
      session: state.session,
      protocolId: protocol.id,
      remainingS: Math.max(0, protocolDurationS(protocol) - (state.resumeFromS ?? 0)),
    })
  }

  const finish = async () => {
    if (!runner) return
    runner.finish()
    if (runner.recordedSamples.length === 0) {
      setToast('Nothing recorded — session not saved.')
      return
    }
    const result = await recorder.finish(Date.now())
    setToast(
      result.error
        ? `${result.copies} copy saved. ${result.detail} ${result.error}`
        : `${result.copies} ${result.copies === 1 ? 'copy' : 'copies'} confirmed. ${result.detail}`,
    )
    await refreshBestCurve()
    setView('analysis')
  }

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 8000)
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

      {interrupted.length > 0 && !status.recording && (
        <div className="resume-banner">
          <div>
            <strong>
              {interrupted.length === 1
                ? 'A session was interrupted.'
                : `${interrupted.length} sessions were interrupted.`}
            </strong>
            <span className="muted small">
              Everything recorded before the interruption is on disk and can be continued.
            </span>
          </div>
          <div className="resume-actions">
            {interrupted.slice(0, 3).map((summary) => (
              <button key={summary.id} onClick={() => void resumeSession(summary)}>
                Resume {summary.protocolName} ({summary.sampleCount} s)
              </button>
            ))}
            <button className="ghost" onClick={() => setInterrupted([])}>
              Not now
            </button>
          </div>
        </div>
      )}

      {view === 'run' &&
        (runner && activeProtocol ? (
          <Dashboard
            runner={runner}
            protocol={activeProtocol}
            athlete={settings.athlete}
            manager={manager}
            bestCurve={bestCurve}
            status={status}
            durability={recorder.durability}
            frontTiles={settings.dashboardTiles?.[activeProtocol.sport] ?? []}
            layout={settings.dashboardLayout?.[activeProtocol.sport]}
            onLayoutChange={(split) =>
              setSettings((s) => ({
                ...s,
                dashboardLayout: { ...s.dashboardLayout, [activeProtocol.sport]: split },
              }))
            }
            fitY={settings.fitYAxis ?? false}
            onFitYChange={(fitYAxis) => setSettings((s) => ({ ...s, fitYAxis }))}
            onOpenSensors={() => setSensorsOpen(true)}
            onEditTiles={() => setTilesOpen(true)}
            onEditEnvironment={() => setEnvironmentOpen(true)}
            conditions={conditions}
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

      {view === 'analysis' && historyOpen && (
        <Longitudinal recorder={recorder} protocols={protocols} onClose={() => setHistoryOpen(false)} />
      )}

      {view === 'analysis' && !historyOpen && (
        <Analysis
          onOpenHistory={() => setHistoryOpen(true)}
          protocols={protocols}
          recorder={recorder}
          salt={settings.participantSalt ?? ''}
          onResume={resumeSession}
        />
      )}

      {view === 'settings' && (
        <Settings
          settings={settings}
          onChange={setSettings}
          onResetAthlete={() => setSettings((s) => ({ ...s, athlete: DEFAULT_ATHLETE as Athlete }))}
        />
      )}

      {sensorsOpen && (
        <SensorPanel
          manager={manager}
          ftpWatts={settings.athlete.ftpWatts}
          rememberedCount={settings.sensors?.known?.length ?? 0}
          onReconnectRemembered={() => void reconnectSensors()}
          probe={probe}
          probing={probing}
          onProbe={() => void probeErg()}
          correcting={settings.powerMatch?.enabled === true}
          onCorrectingChange={(enabled) =>
            setSettings((s) => ({ ...s, powerMatch: { enabled } }))
          }
          onClose={() => setSensorsOpen(false)}
        />
      )}

      {environmentOpen && (
        <EnvironmentForm
          metrics={manager.read()}
          existing={conditions ?? undefined}
          onSave={(reading) => {
            const observed = { ...reading, at: Date.now() }
            setConditions(observed)
            setEnvironmentOpen(false)
            const state = runner?.snapshot().state
            if (runner && (state === 'running' || state === 'paused')) {
              recorder.environment(runner.elapsed, reading)
              setToast('Conditions recorded with the session.')
            } else if (state === 'finished') {
              // The recording is closed. Saying "recorded" here would be a lie.
              setToast('This test has finished, so these were not recorded with it.')
            } else {
              heldConditions.current.push(observed)
              setToast('Conditions noted. They go into the recording when the test starts.')
            }
          }}
          onClose={() => setEnvironmentOpen(false)}
        />
      )}

      {tilesOpen && activeProtocol && (
        <TilePicker
          sport={activeProtocol.sport}
          selected={settings.dashboardTiles?.[activeProtocol.sport] ?? []}
          onChange={(keys) =>
            setSettings((s) => ({
              ...s,
              dashboardTiles: { ...s.dashboardTiles, [activeProtocol.sport]: keys },
            }))
          }
          onClose={() => setTilesOpen(false)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
