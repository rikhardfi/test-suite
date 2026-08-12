# testday

A browser-based performance test-day suite. Build a step or ramp protocol, drive a smart trainer or
treadmill over Bluetooth, watch the athlete's numbers live, and get lactate thresholds, critical power
and a mean-maximal curve out the other end.

Everything runs client-side. No account, no server, no upload — recordings live in your browser's
IndexedDB until you export them.

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
tagged with the step and phase it belongs to. Autosaved every 15 seconds, so a crash mid-test costs a
few seconds rather than the session.

**Analysis.** A third-order fit through the lactate points with six threshold methods reported side by
side (baseline + 1.0 mmol/L, log-log breakpoint, Dmax, modified Dmax, OBLA 2.0 and OBLA 4.0), heart
rate interpolated at each. Plus the mean-maximal power curve, two-parameter critical power with W′,
and normalised power. Export as sample CSV, lap CSV, TCX or raw JSON.

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

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # typecheck + production bundle into dist/
npm run preview    # serve the built bundle
npm test           # unit tests
```

The build is a static bundle — drop `dist/` on any HTTPS host. Set `BASE_PATH` when serving from a
subdirectory:

```bash
BASE_PATH=/testday/ npm run build
```

## Layout

```
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
    metrics.ts     Rolling averages, MMP tracker, normalised power
    analysis.ts    Polynomial fitting, threshold methods, critical power
    storage.ts     IndexedDB for sessions and protocols
    export.ts      CSV, TCX and JSON writers
  ui/              React components and canvas charts
```

Tests cover the parts where being wrong is silent: characteristic parsing (including the inverted
"more data" flag in FTMS and 16-bit counter wraparound), the runner's timing and ERG behaviour, the
MMP tracker against a brute-force search, and every threshold method against a synthetic step test.

```
npm test    # 50 tests
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
