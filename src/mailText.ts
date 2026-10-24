// EVE mail bodies between EVE's markup and plain text (docs/eve-mail.md).
//
// The mail copy keeps a body exactly as ESI gave it: EVE's HTML-like markup,
// with <br> for a line break, <font> for colour and size, and <a href> links
// to in-game things (showinfo:, killReport:, fitting:) as well as web pages.
// Stripping that markup is a decision for whoever shows a mail, so it lives
// here, beside the outgoing-mail rules in mailCompose.ts, rather than in the
// extract. No I/O; tested in test/mailText.test.ts.
import { pipe, replace, trim } from 'ramda'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const codePoint = (n: number): string | null =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null

// One pass, so `&amp;lt;` decodes to the text `&lt;` and not to `<`.
const decodeEntities = replace(
  /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
  (whole: string, entity: string) =>
    (entity[0] === '#'
      ? codePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
      : NAMED_ENTITIES[entity.toLowerCase()]) ?? whole
)

// A web link keeps its address, since the text alone ("click here") loses it.
// An in-game link (showinfo:, killReport:, fitting:, …) keeps only its text:
// the address means something only to the EVE client.
const linkText = (_whole: string, href: string, text: string): string => {
  const label = text.replace(/<[^>]*>/g, '')
  return /^https?:\/\//i.test(href) && label.trim() !== href ? `${label} (${href})` : label
}

/**
 * A stored EVE mail body as plain text: line breaks kept, links reduced to
 * their text (web links keep their address), every other tag removed,
 * entities decoded, runs of blank lines collapsed. Null for no body.
 */
export const mailText = (body: string | null | undefined): string | null =>
  body == null
    ? null
    : pipe(
        replace(/\r\n?/g, '\n'),
        replace(/<br\s*\/?>/gi, '\n'),
        replace(/<\/p\s*>/gi, '\n'),
        replace(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (whole, dq, sq, text) =>
          linkText(whole, dq ?? sq ?? '', text)
        ),
        replace(/<[^>]*>/g, ''),
        decodeEntities,
        replace(/[ \t]+\n/g, '\n'),
        replace(/\n{3,}/g, '\n\n'),
        trim
      )(body)

/**
 * Plain text as an EVE mail body. The EVE client does not show a bare newline
 * as a line break, so each one becomes <br>; `&`, `<` and `>` become entities,
 * so text that looks like markup arrives as the text that was written.
 */
export const textToMailBody = (text: string): string =>
  pipe(
    replace(/\r\n?/g, '\n'),
    replace(/&/g, '&amp;'),
    replace(/</g, '&lt;'),
    replace(/>/g, '&gt;'),
    replace(/\n/g, '<br>')
  )(text)
