/**
 * The version stamped into every export.
 *
 * Kept as a plain constant rather than read from `package.json`, because the
 * renderer has no filesystem and a build-time define would make the value
 * invisible in the source. A test asserts the two agree, so they cannot drift.
 *
 * This number is what makes a derived value reproducible: a threshold or an
 * oxygen estimate is the result of choices in the code, and knowing which code
 * made it is the difference between reproducible and merely repeatable.
 */
export const APP_VERSION = '0.3.0'

export const APP_NAME = 'testday'
