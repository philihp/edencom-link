import { join, map, pipe, reduce, split, take, toUpper } from 'ramda'

// The payer leaderboard on /structure/[structureId] draws a hashed-initial
// circle per pilot rather than a portrait (the design system carries no
// photography). Both halves are pure functions of the name so the server
// render and the client agree, and the same pilot gets the same colour on
// every visit.

// Up to two initials: the first letter of the first two words. A one-word
// name gives one letter; an empty name gives nothing to draw.
export const initialsOf = (name: string): string =>
  pipe(
    split(/\s+/),
    (words: string[]) => words.filter((w) => w.length > 0),
    take(2),
    map((w: string) => toUpper(w.charAt(0))),
    join('')
  )(name.trim())

// A stable hue from the name (djb2 over the codepoints), kept at a muted
// saturation and mid lightness so white initials read on it in both themes.
export const colourOf = (name: string): string => {
  const hash = reduce((acc: number, ch: string) => (acc * 33 + ch.codePointAt(0)!) >>> 0, 5381, [...name])
  return `hsl(${hash % 360} 28% 46%)`
}
