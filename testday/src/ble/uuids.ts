/** Bluetooth SIG assigned numbers used by fitness sensors. */

export const SVC = {
  heartRate: 0x180d,
  cyclingPower: 0x1818,
  cyclingSpeedCadence: 0x1816,
  runningSpeedCadence: 0x1814,
  fitnessMachine: 0x1826,
  battery: 0x180f,
  deviceInformation: 0x180a,
} as const

export const CHR = {
  heartRateMeasurement: 0x2a37,

  cyclingPowerMeasurement: 0x2a63,
  cyclingPowerFeature: 0x2a65,

  cscMeasurement: 0x2a5b,

  rscMeasurement: 0x2a53,

  /** FTMS */
  treadmillData: 0x2acd,
  indoorBikeData: 0x2ad2,
  fitnessMachineFeature: 0x2acc,
  fitnessMachineControlPoint: 0x2ad9,
  fitnessMachineStatus: 0x2ada,
  supportedPowerRange: 0x2ad8,
  supportedSpeedRange: 0x2ad4,
  supportedInclinationRange: 0x2ad5,

  batteryLevel: 0x2a19,
} as const

/** FTMS Fitness Machine Control Point op codes. */
export const FTMS_OP = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetSpeed: 0x02,
  setTargetInclination: 0x03,
  setTargetResistance: 0x04,
  setTargetPower: 0x05,
  startOrResume: 0x07,
  stopOrPause: 0x08,
  setSimulationParameters: 0x11,
  responseCode: 0x80,
} as const

export const FTMS_RESULT: Record<number, string> = {
  0x01: 'success',
  0x02: 'op code not supported',
  0x03: 'invalid parameter',
  0x04: 'operation failed',
  0x05: 'control not permitted',
}
