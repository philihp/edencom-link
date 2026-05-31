/*
 * Sunrise / sunset for a location, via the standard "sunrise equation"
 * (per Wikipedia, the SunCalc-derived formulation). Pure math — no
 * dependencies, no network. Used to drive the day/night theme from where the
 * visitor actually is rather than from their device clock or OS preference.
 */

const RAD = Math.PI / 180
const DAY_MS = 86_400_000
const J1970 = 2_440_588
const J2000 = 2_451_545
const OBLIQUITY = RAD * 23.4397
// The sun's upper limb meets the horizon at -0.833° (allowing for refraction).
const HORIZON = RAD * -0.833
const J0 = 0.0009

const toJulian = (date: Date) => date.valueOf() / DAY_MS - 0.5 + J1970
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS)
const toDays = (date: Date) => toJulian(date) - J2000

const solarMeanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d)

const eclipticLongitude = (m: number) => {
  const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m))
  const perihelion = RAD * 102.9372
  return m + center + perihelion + Math.PI
}

const declination = (eclipticLong: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLong))

const julianCycle = (d: number, lw: number) => Math.round(d - J0 - lw / (2 * Math.PI))
const approxTransit = (ht: number, lw: number, n: number) => J0 + (ht + lw) / (2 * Math.PI) + n
const solarTransitJ = (ds: number, m: number, l: number) => J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l)

type SunContext = {
  lw: number
  phi: number
  n: number
  m: number
  l: number
  dec: number
  jnoon: number
}

const sunContext = (latitude: number, longitude: number, date: Date): SunContext => {
  const lw = RAD * -longitude
  const phi = RAD * latitude
  const d = toDays(date)
  const n = julianCycle(d, lw)
  const ds = approxTransit(0, lw, n)
  const m = solarMeanAnomaly(ds)
  const l = eclipticLongitude(m)
  const dec = declination(l)
  const jnoon = solarTransitJ(ds, m, l)
  return { lw, phi, n, m, l, dec, jnoon }
}

// Cosine of the hour angle at the horizon. Outside [-1, 1] there is no
// sunrise/sunset that day: < -1 is polar day (sun never sets), > 1 is polar
// night (sun never rises).
const horizonCos = (phi: number, dec: number) =>
  (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))

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
  const { lw, phi, n, m, l, dec, jnoon } = sunContext(latitude, longitude, date)
  const transit = fromJulian(jnoon)
  const cosH = horizonCos(phi, dec)
  if (cosH < -1 || cosH > 1) return { sunrise: null, sunset: null, transit }
  const w0 = Math.acos(cosH)
  const jset = solarTransitJ(approxTransit(w0, lw, n), m, l)
  const jrise = jnoon - (jset - jnoon)
  return { sunrise: fromJulian(jrise), sunset: fromJulian(jset), transit }
}

/** Whether the sun is currently above the horizon at the given location. */
export const isDaytime = (latitude: number, longitude: number, date: Date = new Date()): boolean => {
  const { phi, dec } = sunContext(latitude, longitude, date)
  const cosH = horizonCos(phi, dec)
  if (cosH < -1) return true // polar day
  if (cosH > 1) return false // polar night
  const { sunrise, sunset } = getSunTimes(latitude, longitude, date)
  if (!sunrise || !sunset) return true
  const t = date.valueOf()
  return t >= sunrise.valueOf() && t < sunset.valueOf()
}
