/*
 * Minimal type declarations for `suncalc3`, which ships no usable types
 * (its package.json points at a suncalc.d.ts that isn't published, and there
 * is no @types/suncalc3). Only the surface we use is declared here.
 */
declare module 'suncalc3' {
  interface ISunTimeDef {
    name: string
    /** Date object with the calculated sun-time. */
    value: Date
    /** The time as a timestamp. */
    ts: number
    /** Indicates whether the time is valid (false during polar day/night). */
    valid: boolean
  }

  interface ISunTimes {
    solarNoon: ISunTimeDef
    nadir: ISunTimeDef
    sunriseStart: ISunTimeDef
    sunriseEnd: ISunTimeDef
    sunsetStart: ISunTimeDef
    sunsetEnd: ISunTimeDef
    [key: string]: ISunTimeDef
  }

  interface ISunPosition {
    azimuth: number
    altitude: number
    azimuthDegrees: number
    altitudeDegrees: number
    zenith: number
    zenithDegrees: number
    declination: number
  }

  const SunCalc: {
    getSunTimes(
      dateValue: Date | number,
      latitude: number,
      longitude: number,
      height?: number,
      addDeprecated?: boolean,
      inUTC?: boolean
    ): ISunTimes
    getPosition(dateValue: Date | number, latitude: number, longitude: number): ISunPosition
  }

  export default SunCalc
}
