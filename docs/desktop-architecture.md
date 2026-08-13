# testday on the desktop: rigidity, data safety, uptime

Two requirements drive everything here: **no recorded data may be lost**, and **the app stays up for
the whole session**. Both are stated as absolutes, so the design below treats them as absolutes.

## The real question is not web versus desktop

Today the recorder and the user interface are the same process. `App.tsx` holds the runner in memory
and writes the entire `SessionRecord` into IndexedDB every 15 seconds (`AUTOSAVE_MS = 15000`).

That gives four failure modes, none of which a desktop shell fixes by itself:

1. A React error, an accidental Cmd-W, or a tab reload ends the test and costs up to 15 seconds.
2. Each autosave rewrites the whole record. A failure mid-write puts the entire session at risk,
   not one sample.
3. IndexedDB is invisible to the user, evictable by the browser, and not something anyone can back up.
4. A write failure is silent. The operator finds out afterwards.

So the goal is not "make it a desktop app". The goal is **separate the recorder from the interface,
and make the recorder append to a real file**. The desktop shell is what makes that possible.

## Recommendation: Electron, in two phases

### Phase 1, the shell and the journal (roughly 2 to 3 days)

Electron ships its own Chromium, so **Web Bluetooth keeps working and `src/ble/*` is untouched**.
All 50 existing tests stay valid. That single fact is the main reason to pick Electron over the
alternative below.

- **Device picker.** Electron has no built-in Bluetooth chooser. Handle `select-bluetooth-device` on
  the `webContents` and drive your own list, otherwise `requestDevice()` hangs forever with no error.
  `ui/SensorPanel.tsx` is already the right place for that list.
- **macOS permissions.** `NSBluetoothAlwaysUsageDescription` in the Info.plist, and the app has to be
  signed and notarised before it will run anywhere but your own machine.
- **Recording moves to the main process.** The renderer sends each 1 Hz sample over IPC; the main
  process appends one NDJSON line to an already-open file descriptor and fsyncs. One write per second
  is nothing, so fsync every sample rather than batching.
- **Journal layout.** `~/testday/sessions/<session-id>/journal.ndjson` plus `meta.json`. First line is
  the header (protocol, athlete, start time). A clean stop writes a final `{"type":"closed"}` record.
- **Crash resume.** On launch, any journal without a closing record is an interrupted session. Offer
  to resume it rather than silently listing it as finished.
- **Files become the truth.** IndexedDB stops being the source of record. Keep it as a read cache if
  it saves work, or drop it entirely.

The web build still works from the same codebase, so nothing is lost by doing this.

### Phase 2, move Bluetooth out of the renderer (roughly 1 to 2 weeks)

Put BLE itself in the main process using Node `noble`. The renderer becomes a pure view that can
crash, be closed, or be reopened in the middle of a test without capture noticing.

`ble/parse.ts` is pure byte decoding and ports across unchanged, tests included. The rewrite is
confined to `manager.ts` and `ftms.ts`, which are the transport layers.

Phase 1 removes the data-loss risk. Phase 2 removes the uptime risk. If you only ever do phase 1,
you are still far ahead of where the app is now.

## Why not Tauri, on macOS

Tauri uses the system webview, which on macOS is WKWebView, and **WKWebView does not implement Web
Bluetooth at all**. Tauri therefore forces the native BLE rewrite on day one rather than as a phase 2,
using the Rust `btleplug` crate.

The endpoint is arguably better (smaller binary, lower memory, no browser permission model in the
way), but it discards a working and tested Bluetooth layer immediately. Choose Tauri only if you
intend to do phase 2 anyway and would rather not write phase 1 twice.

## No data loss, concretely

1. **Append only, never rewrite.** Tail corruption then costs one sample instead of the session.
2. **fsync per sample.** At 1 Hz the cost is irrelevant and the guarantee is absolute.
3. **Fail loud.** A failed write turns the dashboard red at once. A silent write failure is worse
   than a crash, because the operator keeps testing.
4. **Do not journal into OneDrive.** A file held open and continuously appended is exactly what sync
   clients handle badly. Journal to local disk, copy into OneDrive when the session closes.
5. **Two copies before the athlete leaves the room.** On close, mirror to OneDrive or a USB stick,
   and show the operator that both copies exist.
6. **The app never deletes anything on its own initiative.** Deletion is manual and confirmed.

## Uptime, concretely

- `powerSaveBlocker.start('prevent-display-sleep')` while a session is open. Display sleep on macOS
  can drop Bluetooth connections.
- **No auto-update and no network calls during a session.** Pin the version for a test day and update
  on your own schedule, never on the morning of a test.
- **Automatic renderer relaunch** on crash. After phase 2, capture does not even notice.
- **Bluetooth dropouts record a gap and continue.** Reconnection with backoff already exists in
  `manager.ts`. The rule is never to abort a recording because a sensor went quiet.
- **Rehearse on the actual machine** with the built-in simulator before the athlete arrives.
- Operational, not code: mains power, macOS updates deferred, Do Not Disturb on, and a second machine
  carrying the same build.

## What this does not fix

A desktop shell does nothing about the athlete-facing risk, which is a test day that produces numbers
nobody can interpret. That belongs to the shelved items in `tasks/todo.md`, in particular recording
the environmental conditions of the test.
