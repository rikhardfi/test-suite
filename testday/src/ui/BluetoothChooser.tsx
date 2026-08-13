import { useEffect, useState } from 'react'
import type { BluetoothDeviceInfo } from '../../electron/ipc'

/**
 * Electron ships no Bluetooth device chooser, so the app has to be one.
 *
 * While `requestDevice` is pending, the main process forwards the growing list
 * of discovered devices here; picking one resolves it, and cancelling resolves
 * it with an empty id. If nothing ever answers, `requestDevice` hangs forever,
 * which is why the cancel path is wired to the panel closing as well.
 */
export function useBluetoothChooser(active: boolean): {
  devices: BluetoothDeviceInfo[]
  scanning: boolean
  pick: (deviceId: string) => void
  cancel: () => void
} {
  const [devices, setDevices] = useState<BluetoothDeviceInfo[]>([])
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    const bridge = window.testday
    if (!bridge) return
    return bridge.onBluetoothDevices((next) => {
      setDevices(next)
      setScanning(true)
    })
  }, [])

  // A new pairing attempt starts from an empty list rather than showing the
  // devices found during the previous one.
  useEffect(() => {
    if (active) return
    setDevices([])
    setScanning(false)
  }, [active])

  const settle = (deviceId: string) => {
    window.testday?.selectBluetoothDevice(deviceId)
    setDevices([])
    setScanning(false)
  }

  return {
    devices,
    scanning,
    pick: settle,
    cancel: () => settle(''),
  }
}

export function BluetoothChooser({
  devices,
  scanning,
  onPick,
  onCancel,
}: {
  devices: BluetoothDeviceInfo[]
  scanning: boolean
  onPick: (deviceId: string) => void
  onCancel: () => void
}) {
  if (!scanning) return null

  return (
    <div className="chooser">
      <div className="chooser-head">
        <strong>Scanning…</strong>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {devices.length === 0 ? (
        <p className="muted small">
          No devices yet. Wake the sensor up: put the strap on, or turn the cranks.
        </p>
      ) : (
        <ul className="chooser-list">
          {devices.map((device) => (
            <li key={device.deviceId}>
              <button onClick={() => onPick(device.deviceId)}>{device.deviceName}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
