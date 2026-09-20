# The power meter still drops after the start, and we cannot see why

Reported again after PR #1: a Quarq pairs, holds the link through setup, and goes once the athlete
starts working. The reconnection hardening in #1 did not fix it.

That is worth being precise about, because it narrows the problem rather than reopening it.

## What #1 did and did not do

#1 was about **recovery**: what the app does once a link is already lost. One reconnect loop per
device instead of one per drop event, a three-second backoff ceiling while recording, a half-open
link thrown away rather than retried down, notification handlers and poll timers that end with their
session. Those were real defects — eight of the eleven cases in `src/ble/manager.test.ts` fail
against the code before it — and they made a meter that dropped repeatedly progressively *less*
likely to come back.

It did nothing about **why the link drops in the first place**, and it was never going to. If the
meter is being taken by another device, or browning out, or losing the link faster than any scheme
can restore it, better recovery buys a shorter gap and nothing else.

So the remaining question is a different one, and the honest answer today is that **the app cannot
tell us**. That is the thing to fix first.

## What the app records now, and what it does not

| | Recorded | Where |
| --- | --- | --- |
| Decoded metrics at native rate | yes | `raw.ndjson`, via `recorder.raw` |
| A metric changing hands between devices | yes | `sourceChanged` event in the journal |
| Raw notification bytes | only when capture is on | `TraceRecorder`, sensor panel |
| Battery level at connect | read, shown, **not journalled** | `SensorDevice.batteryPct` |
| **A device dropping its link** | **no** | — |
| **A reconnect attempt, and why it failed** | **no** | — |
| **How long the gap lasted** | only inferable | — |

The dropout counter added in #1 lives on `SensorDevice.drops` and is shown in the sensor panel, but
it is a live counter on an object in memory. Nothing writes it down. When the operator comes back
from a test and says "it dropped a lot", there is no record that says how many times, when, for how
long, or what the browser said about it.

`sourceChanged` is the closest thing we have: when the meter goes quiet for five seconds, `power`
changes hands to the trainer, and that *is* journalled. It gives the approximate times of gaps
longer than the staleness window and nothing about their cause.

## Step 1 — instrument, before theorising

Journal the connection lifecycle so the next test day produces evidence instead of an impression.
`SensorManager` already knows all of this; it simply keeps it to itself.

Add to `JournalEventKind` in `src/model/journal.ts`:

- `sensorDropped` — `{ deviceId, name, kind, atElapsed }`
- `sensorReconnecting` — `{ deviceId, attempt, waitMs }`
- `sensorReconnected` — `{ deviceId, attempt, gapS }`
- `sensorReconnectFailed` — `{ deviceId, attempt, error }`, where `error` is the rejection's `name`
  and `message` verbatim from `gatt.connect()` or `getPrimaryService()`

The error text is the part that matters most, and it is currently swallowed: `reconnectLoop`'s catch
block discards the rejection entirely. Web Bluetooth's messages are more informative than they look
— `NetworkError: Connection failed`, `NotFoundError`, `GATT operation already in progress`,
`GATT Server is disconnected`, `Device is no longer in range` each point somewhere different, and
"another device is holding this peripheral" has its own signature.

Wiring: `SensorManager` needs a listener in the shape of the existing `onSourceChange`, subscribed
in `App.tsx` alongside the others, and only while a recording is open. Also journal `batteryPct`
whenever it is read, so a cell that reads 100% at pairing and 40% ten minutes into a session tells
its own story.

Keep it to the manager and the journal. This is a diagnostic change, not a behavioural one — nothing
about how reconnection works should move until we know what we are looking at.

## Step 2 — what to capture on the next test day

1. **Turn on raw capture** in the sensor panel before the athlete gets on, and save the trace at the
   end. It timestamps every notification per device, so the last packet before each gap is visible.
2. **Note the battery** the panel shows at pairing, and what it shows at the end.
3. **Run the session as normal.** Do not baby it — a reproduction is the point.
4. **Afterwards, record three numbers**: how many minutes in the first drop came, whether it
   recovered on its own, and whether it kept dropping or went once and stayed gone.
5. **`chrome://device-log`** in the same browser profile holds Chrome's own Bluetooth event log,
   including disconnect reasons the page never sees. Copy it out before closing the browser; it does
   not survive. `chrome://bluetooth-internals` shows live connection state alongside it.

If this is the Electron app rather than a browser tab, the same pages are reachable from the
renderer's devtools.

## Step 3 — hypotheses, ranked, each with the observation that settles it

Ordered by how well each explains "holds through setup, goes once the athlete starts working",
which is a much more specific symptom than "it drops".

**1. Something else takes the meter.** A cycling power peripheral accepts one connection at a time.
A head unit on the bars, a phone with the SRAM AXS app in the jersey pocket, an iPad running Zwift
in the corner — any of them that knows this meter will grab it the moment it starts advertising, and
a meter that has just woken up under pedalling is doing exactly that. This explains the timing
better than anything else on this list.

*Settles it:* our reconnect attempts fail persistently while the meter is plainly alive and the
other device is showing power. With #1 merged, that now looks like a device stuck in "reconnecting"
with a climbing attempt count rather than one that went quiet. *Kills it:* put every other device in
aeroplane mode or out of the room, then repeat.

**2. The coin cell sags under load.** A Quarq draws far more once it is measuring and transmitting
continuously than it does idling, and a CR2032 near the end of its life holds up at rest and browns
out under that draw. Also fits the timing exactly.

*Settles it:* the battery figure the panel already reads at connect, and the same figure after a
failure. *Kills it:* a fresh cell, seated properly, and repeat. Worth doing early regardless — it is
the cheapest test on this list and the most common cause in the field.

**3. Radio contention at the moment the test starts.** ERG control begins at the start: control point
writes, indications back, plus 1 Hz notifications from the trainer, the strap, and anything else
paired, all on a band that also carries the building's Wi-Fi. The meter's supervision timeout is the
first thing to go.

*Settles it:* drops that cluster at the start and correlate with the number of paired devices.
*Kills it:* run the protocol with the trainer unpaired and the meter alone, same effort.

**4. Geometry.** The crank antenna passes behind the rider's leg every revolution, and the rider's
body sits between it and the laptop for part of it. A laptop on the floor behind the bike is a much
worse place for it than one on a table beside the bars.

*Settles it:* moving the machine changes the drop rate. Cheap to test, worth recording where it was.

**5. The host's Bluetooth stack.** `prevent-display-sleep` is held while a session is recording
(`electron/main.ts:541`), so a recording session is covered, but it does not prevent system sleep and
it does not apply before the session begins or in a browser tab. Lower down the list because the
reported symptom starts *at* exercise start, which is when the blocker is on.

*Settles it:* `chrome://device-log` showing the stack dropping the link rather than the peer.

## What this is not

Not a reason to widen the reconnection code again. #1's changes stand on their own — the duplicate
subscription bug alone was corrupting the raw journal with packets recorded up to four times — and
none of them should be reverted or tuned further until Step 1 has produced a log that says what is
actually happening.
