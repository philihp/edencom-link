/*
 * Sunrise / sunset for a location, backed by the `suncalc3` library. Used to
 * drive the day/night theme from where the visitor actually is rather than
 * from their device clock or OS preference.
 */

import SunCalc from 'suncalc3'

export type SunTimes = {
  /** Sunrise (UTC), or null during polar day/night. */
  sunrise: Date | null
  /** Sunset (UTC), or null during polar day/night. */
  sunset: Date | null
  /** Solar noon (UTC) — always defined. */
  transit: Date
}

/** Sunrise, sunset and solar noon for the day nearest `date` at the location. */
export const getSunTimes = (latitude: number, longitude: number, date: Date = new Date()): SunTimes => {
  const t = SunCalc.getSunTimes(date, latitude, longitude)
  // During polar day/night there is no rise/set; suncalc3 flags those as invalid.
  return {
    sunrise: t.sunriseStart.valid ? t.sunriseStart.value : null,
    sunset: t.sunsetEnd.valid ? t.sunsetEnd.value : null,
    transit: t.solarNoon.value,
  }
}

/** Whether the sun is currently above the horizon at the given location. */
export const isDaytime = (latitude: number, longitude: number, date: Date = new Date()): boolean => {
  // The sun's upper limb meets the horizon at -0.833° (allowing for
  // refraction); above that it's daytime. Using the sun's altitude directly
  // handles polar day/night without special-casing.
  const { altitudeDegrees } = SunCalc.getPosition(date, latitude, longitude)
  return altitudeDegrees > -0.833
}
