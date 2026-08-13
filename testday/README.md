# testday

A performance test-day suite. Build a step or ramp protocol, drive a smart trainer or treadmill over
Bluetooth, watch the athlete's numbers live, and get lactate thresholds, critical power and a
mean-maximal curve out the other end.

It runs as a **desktop app**, which is what lets a recording be written to a file as it happens rather
than held in a browser tab that can be closed. Nothing leaves the machine: no account, no server, no
upload, and no network requests at all. The same code still runs in a browser for demos and rehearsals,
with the weaker storage that implies.

## What it does

**Protocols.** Built-in templates for the usual lab tests (4 min and 8 min lactate step tests, a
25 W/min ramp, a Norwegian-style double-threshold session, 30/15s, a 20 min FTP test, a treadmill step
test) plus a generator and a step-by-step editor for your own. Targets are either absolute watts,
a percentage of threshold power, or treadmill speed with a gradient.

**Live control.** The runner advances steps on a wall-clock timer, computes the target for the current
second (interpolating through ramps), and pushes it to the machine over FTMS. Steps can carry a
sampling break — an easy spin at the end of the stage during which the dashboard prompts for a blood
lactate value. Global intensity trim (±1%), step skip, pause, and a lap table you can double-click to
jump around in.

**Capture.** One sample per second of power, heart rate, cadence, speed and the commanded target,
tagged with the step and phase it belongs to. In the desktop app every sample is appended to a file
and flushed to disk as it happens, so a crash costs nothing and an interrupted session is offered
back for resume on the next launch. See [Recordings](#recordings).

**Analysis.** A third-order fit through the lactate points with six threshold methods reported side by
side (baseline + 1.0 mmol/L, log-log breakpoint, Dmax, modified Dmax, OBLA 2.0 and OBLA 4.0), heart
rate interpolated at each, and a leave-one-out band on every one of them so the estimate is read to
the precision it actually has. A longitudinal view overlays an athlete's test days against each
other, and a metabolic cart export can be imported to place VT1 and VT2 beside the lactate
thresholds. Plus the mean-maximal power curve, two-parameter critical power with W′,
and normalised power. Export as sample CSV, lap CSV, FIT or raw JSON, plus a research export that
pairs a pseudonymised 1 Hz CSV with a sidecar describing every column, every equation used, and the
protocol as actually executed.

## Bluetooth support

Connects over Web Bluetooth using standard Bluetooth SIG fitness profiles — no vendor SDKs, so
anything that follows the spec works.

| Profile | UUID | Used for |
| --- | --- | --- |
| Heart Rate | `0x180D` | Heart rate, RR intervals |
| Cycling Power | `0x1818` | Power, cadence, wheel speed |
| Cycling Speed and Cadence | `0x1816` | Speed, cadence |
| Running Speed and Cadence | `0x1814` | Pace, cadence, distance |
| Fitness Machine (FTMS) | `0x1826` | Indoor bike and treadmill data, **plus ERG and pace control** |
| Battery | `0x180F` | Battery level |

FTMS control point commands used: request control, set target power (ERG), set target speed, set
target inclination, start, stop. Commands are serialised one at a time and matched against their
indication, because trainers drop overlapping writes.

When two devices report the same metric — a power meter and a trainer both sending watts, say — the
more authoritative source wins by default (dedicated sensor over machine estimate). You can override
the choice per metric in the sensor panel.

Dropped connections reconnect automatically with backoff. A metric older than five seconds stops being
displayed rather than showing a stale number.

### Browser requirements

Web Bluetooth is implemented in **Chrome, Edge and Opera** on desktop (macOS, Windows, Linux, ChromeOS)
and on Android. **Safari and Firefox do not implement it at all**, so on iOS and iPadOS no browser can
do this — that is a platform limitation, not something this app can work around.

The page must be served over HTTPS or from `localhost`.

### No hardware? Use the simulator

The sensor panel has a **Simulator** button: a synthetic trainer and athlete that answers ERG targets
with a realistic first-order lag, produces pedalling noise, and drives a heart rate that lags power and
drifts upward above threshold. Works in any browser, including ones without Web Bluetooth. Use it to
rehearse a protocol before the athlete is on the bike.

## Recordings

The desktop app records to an **append-only journal**: one JSON object per line, `fsync`ed before the
write returns. Nothing is ever rewritten, so the worst a crash can do is cut the final line.

```
~/Documents/testday/sessions/2026-08-12_07-31_session_xyz/
  journal.ndjson   one line per sample, appended live
  meta.json        cached summary for the session list, rewritten on close
```

- **A journal with no `closed` record is an interrupted session.** That is the only signal needed, so
  there is no lock file to go stale. The app offers it back for resume on the next launch and picks
  the clock up at the last sample on disk.
- **A truncated final line is discarded on read** and everything before it survives. This is the
  normal state of a journal whose process was killed mid-write.
- **The second copy is made only after the session closes.** A file that is held open and continuously
  appended is exactly what a sync client handles badly, so OneDrive never sees a live journal. The
  copy is verified by size and SHA-256, re-read from the destination, before the app claims two copies
  exist.
- **Nothing is deleted.** Removing a session from the list moves it to `~/Documents/testday/discarded/`.
- **A failed write turns the dashboard pill red immediately.** A silent write failure is worse than a
  crash, because the operator carries on testing into nothing.

### What this does and does not survive

| Failure | Outcome |
| --- | --- |
| App crash, `kill -9`, forced quit | Everything up to the last completed sample. Resume offered. |
| Renderer crash or reload | Same. The journal lives in the main process. |
| OS panic or reboot | Same, because each append is fsynced. |
| **Sudden power loss** | **The last few seconds may be lost.** |
| Disk failure | The OneDrive copy of every *closed* session. An open one is gone. |

The power-loss caveat is real and worth stating plainly: on macOS `fsync` does not flush the drive's
own write cache, and Node does not expose `F_FULLFSYNC`. Run test days on mains power, and close a
session before unplugging anything.

The browser build has none of this. A browser cannot append to a file, so it falls back to rewriting
the whole session into IndexedDB every 15 seconds. It is there for demos and for rehearsing a protocol
with the simulator. Anything with an athlete on it belongs on the desktop app.

## Running it

```bash
npm install
npm run electron:dev    # the desktop app, with hot reload
```

```bash
npm run electron:build  # typecheck, bundle renderer and main process
npm run electron:start  # run the built app
npm run dist            # package a local .app into release/
npm test                # unit tests
```

The browser version still builds from the same source:

```bash
npm run dev             # http://localhost:5173
npm run build           # static bundle into dist/
npm run preview
```

`dist/` can be dropped on any HTTPS host. Set `BASE_PATH` when serving from a subdirectory:

```bash
BASE_PATH=/testday/ npm run build
```

The desktop app makes **no network requests at all** — non-local requests are blocked outright and
there is no updater. Nothing about it can hang on a conference-centre network on the morning of a test.

## Layout

```
electron/
  main.ts        window, IPC, sleep blocker, close guard, Bluetooth chooser relay
  preload.ts     the window.testday bridge, the renderer's only reach into the recorder
  ipc.ts         channel names and payload types, shared by both sides
  journal.ts     the file half of the journal: open, append, fsync
  sessions.ts    session directories, listing, resume, mirror and verification
src/
  ble/
    uuids.ts       Assigned numbers and FTMS op codes
    parse.ts       Characteristic decoders + revolution-counter maths
    ftms.ts        Fitness machine control point client
    manager.ts     Connection lifecycle, reconnection, metric arbitration
    simulator.ts   Synthetic trainer and athlete
  model/
    protocol.ts    Protocol/step types, target resolution, builders
    presets.ts     Built-in test protocols
    session.ts     The runner: clock, step advance, ERG push, recording
    journal.ts     The on-disk record format: encode, decode, reconstruct
    recorder.ts    Where a recording goes; file backend on desktop, IndexedDB in a browser
    metrics.ts     Rolling averages, MMP tracker, normalised power
    analysis.ts    Polynomial fitting, threshold methods, critical power, W-prime, decoupling
    ventilatory.ts Cart import, V-slope VT1 and VE/VCO2 VT2
    longitudinal.ts One athlete across test days, with the bands carried through
    storage.ts     IndexedDB for sessions and protocols
    export.ts      CSV and JSON writers
    fit.ts         FIT encoder, including the developer fields TCX had nowhere for
    research.ts    Frozen CSV column contract, metadata sidecar, participant codes
  ui/              React components and canvas charts
```

Tests cover the parts where being wrong is silent: characteristic parsing (including the inverted
"more data" flag in FTMS and 16-bit counter wraparound), the runner's timing and ERG behaviour, the
MMP tracker against a brute-force search, every threshold method against a synthetic step test, and
the journal.

The journal tests are the ones that matter most, because a recording bug is not visible until the
recording is needed. They cover encoding round-trips, a truncated final line, a corrupt line in the
middle, resume positioning, and mirror verification. One test spawns a real child process, kills it
with `SIGKILL` mid-recording, and checks that every sample the recorder acknowledged is on disk with
no gaps: truncating a file by hand only tests the reader, not the durability claim.

```
npm test    # 90 tests
```

## Notes on the numbers

Threshold methods disagree with each other by design, which is why all six are shown rather than one
"answer". On a well-formed step test the log-log and baseline methods bracket LT1, and modified Dmax
and OBLA 4.0 bracket LT2. Dmax lands between them and is sensitive to where the test started, so a long
easy warm-up stage will drag it down.

Critical power is fitted as the linear work–time model over efforts between 2 and 20 minutes. It needs
maximal efforts in that range to mean anything — running it on a submaximal step test will produce a
number, and that number will be meaningless.

Blood lactate is entered by hand. There is no consumer BLE lactate meter to read from; the meters used
in labs are not Bluetooth devices with a public profile.

## Licence

MIT.
