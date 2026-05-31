/*
 * Whether the sun is currently up at a location, backed by the `@hebcal/noaa`
 * library (NOAA solar algorithm). Used to drive the day/night theme from where
 * the visitor actually is rather than from their device clock or OS preference.
 */

import { NOAACalculator } from '@hebcal/noaa'
// @hebcal/noaa types its Temporal arguments against the global `Temporal`
// namespace and installs the temporal-polyfill global itself at load time; this
// side-effect import brings in the matching global type so we can build the
// ZonedDateTime it expects.
import 'temporal-polyfill/global'

/** Whether the sun is currently above the horizon at the given location. */
export const isDaytime = (latitude: number, longitude: number, date: Date = new Date()): boolean => {
  const when = Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO('UTC')
  // The sun's upper limb meets the horizon at -0.833° (allowing for
  // refraction); above that it's daytime. Using the sun's elevation directly
  // handles polar day/night without special-casing.
  return NOAACalculator.getSolarElevation(when, latitude, longitude) > -0.833
}
