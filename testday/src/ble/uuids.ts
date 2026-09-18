/** Bluetooth SIG assigned numbers used by fitness sensors. */

export const SVC = {
  heartRate: 0x180d,
  cyclingPower: 0x1818,
  cyclingSpeedCadence: 0x1816,
  runningSpeedCadence: 0x1814,
  fitnessMachine: 0x1826,
  battery: 0x180f,
  deviceInformation: 0x180a,
  environmentalSensing: 0x181a,
} as const

/**
 * Environmental Sensing Service. The SIG's own profile for a room sensor, so
 * any monitor that implements it works without the app knowing its maker.
 */
export const ESS_CHR = {
  pressure: 0x2a6d,
  temperature: 0x2a6e,
  humidity: 0x2a6f,
} as const

/**
 * CORE Body Temperature Service, a vendor service rather than a SIG-assigned
 * one, so its UUIDs are full 128-bit strings.
 *
 * Specification: "Core Body Temperature Service", CoreBodyTemp/CoreBodyTemp on
 * GitHub. Sensors advertise the service UUID; the advertised *name* is not
 * reliable and must not be filtered on.
 */
export const CORE_SVC = '00002100-5b1e-4347-b07c-97b514dae121'

export const CORE_CHR = {
  /** Core body temperature measurement. Read, Notify. */
  measurement: '00002101-5b1e-4347-b07c-97b514dae121',
  /** CoreTemp control point, for pairing the sensor to a heart rate monitor. */
  controlPoint: '00002102-5b1e-4347-b07c-97b514dae121',
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

/**
 * Aranet4 environment monitor: CO₂, temperature, relative humidity, pressure.
 *
 * A vendor service, so full 128-bit UUIDs. Two things about this device decide
 * how it is used here rather than how it is parsed:
 *
 * 1. It measures every 1, 2, 5 or 10 minutes, not every second. It is an
 *    environment channel, not a metric channel, and carrying it at 1 Hz would
 *    produce a column of repeats that reads as if it had been measured that
 *    often.
 * 2. Recent firmware requires Bluetooth bonding before the readings
 *    characteristic can be read, and Web Bluetooth cannot drive a passkey
 *    pairing flow. Whether this device works at all through this app is a
 *    question about the firmware in front of you, not about this code, and it
 *    has to be answered on the hardware.
 */
export const ARANET_SVC = 'f0cd1400-95da-4f4b-9ac8-aa55d312af0c'

export const ARANET_CHR = {
  /** Current readings: CO₂, temperature, pressure, humidity, battery. */
  currentReadings: 'f0cd3001-95da-4f4b-9ac8-aa55d312af0c',
  /** Seconds between measurements, so the app can say how fresh a reading is. */
  interval: 'f0cd2002-95da-4f4b-9ac8-aa55d312af0c',
  /** Seconds since the last measurement. */
  sinceMeasurement: 'f0cd2004-95da-4f4b-9ac8-aa55d312af0c',
} as const
