// A minimal protobuf reader, enough for the six `.pb2` files `/esf/[file]`
// serves (see src/esf.proto). Written rather than pulled in: protobufjs is
// ~100KB for a wire format we only ever *read*, in exactly one schema shape —
// a top-level `map<int32, Message>` of flat messages, at most three levels
// deep, using only varints, floats, bools, strings and nested messages.
//
// Schema-driven instead of code-generated: the six messages are declared as
// data in ./schema.ts, so the decoder itself is ~100 lines and the schema
// diffs against src/esf.proto by eye.
//
// Defaults follow proto2 (and thus the generated decoder @eveshipfit/react
// vendors, which this replaces): a *required* field that somehow didn't make
// it into the file reads back as its type's zero, an absent *optional* field
// reads back `undefined`. Both come from a per-message prototype rather than
// own properties, exactly like the generated code — so `Object.keys()` of a
// decoded message lists only the fields actually on the wire, which is what
// the WASM engine's deserializer sees when it reads these objects back.

const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_LENGTH = 2
const WIRE_32BIT = 5

export type ScalarKind = 'int32' | 'float' | 'bool' | 'string'

export type Field =
  { name: string; kind: ScalarKind } | { name: string; kind: 'message'; of: MessageSpec; repeated?: boolean }

// `fields` is keyed by protobuf field number; `defaults` becomes the prototype
// of every decoded instance (so absent fields resolve to the proto2 default
// without ever being own properties).
export type MessageSpec = {
  fields: Record<number, Field>
  defaults: Record<string, unknown>
}

// A cursor over the whole file. The upstream reader streams chunks as they
// arrive; we read the complete response first — these files are a few MB and
// come from a CDN-cached route, and decoding all six takes well under the time
// the fetches themselves do.
class Reader {
  readonly bytes: Uint8Array
  pos = 0
  private readonly view: DataView

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  // Varints are little-endian base-128. Read at most 10 bytes (the encoding of
  // a negative int32, sign-extended to 64 bits) and keep the low 32 — the same
  // truncation `int32` does upstream.
  varint(): number {
    let value = 0
    let shift = 0
    for (let i = 0; i < 10; i++) {
      const byte = this.bytes[this.pos++]
      if (shift < 32) value |= (byte & 0x7f) << shift
      shift += 7
      if (byte < 0x80) break
    }
    return value
  }

  int32(): number {
    return this.varint() | 0
  }

  bool(): boolean {
    return this.varint() !== 0
  }

  float(): number {
    const value = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return value
  }

  // Every string in these files is a type/attribute/effect/group name: ASCII
  // in practice, but decoded as UTF-8 so a non-ASCII name survives intact
  // (the vendored reader's byte-per-char loop would mangle it).
  string(): string {
    const length = this.varint()
    const bytes = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return new TextDecoder().decode(bytes)
  }

  // Unknown field: step over it so a file written by a newer schema still
  // decodes the fields we do know (the vendored reader throws here).
  skip(wireType: number): void {
    if (wireType === WIRE_VARINT) this.varint()
    else if (wireType === WIRE_64BIT) this.pos += 8
    else if (wireType === WIRE_32BIT) this.pos += 4
    else if (wireType === WIRE_LENGTH) this.pos += this.varint()
    else throw new Error(`esf: unsupported wire type ${wireType}`)
  }
}

// A repeated field is always an own array, empty when nothing was on the wire
// — the generated decoder assigns one in its constructor, so a consumer can
// iterate without a presence check. Derived once per spec.
const repeatedFields = new WeakMap<MessageSpec, string[]>()
const repeatedNames = (spec: MessageSpec): string[] => {
  let names = repeatedFields.get(spec)
  if (names === undefined) {
    names = Object.values(spec.fields)
      .filter((field) => field.kind === 'message' && field.repeated)
      .map((field) => field.name)
    repeatedFields.set(spec, names)
  }
  return names
}

const decodeMessage = (reader: Reader, end: number, spec: MessageSpec): Record<string, unknown> => {
  const message: Record<string, unknown> = Object.create(spec.defaults)
  for (const name of repeatedNames(spec)) message[name] = []

  while (reader.pos < end) {
    const tag = reader.varint()
    const field = spec.fields[tag >>> 3]
    if (field === undefined) {
      reader.skip(tag & 7)
      continue
    }

    if (field.kind === 'message') {
      const length = reader.varint()
      const value = decodeMessage(reader, reader.pos + length, field.of)
      if (field.repeated) {
        ;(message[field.name] as unknown[]).push(value)
      } else {
        message[field.name] = value
      }
    } else if (field.kind === 'int32') {
      message[field.name] = reader.int32()
    } else if (field.kind === 'float') {
      message[field.name] = reader.float()
    } else if (field.kind === 'bool') {
      message[field.name] = reader.bool()
    } else {
      message[field.name] = reader.string()
    }
  }

  return message
}

// Each file is a single message whose only field is `map<int32, V> entries = 1`.
// A protobuf map is repeated `{ key = 1, value = 2 }` entry messages, so the
// map is read here rather than declared in the schema: the result is the plain
// `Record<id, V>` object every consumer (and the WASM engine's data callbacks)
// expects, keyed by the id as a string.
export const decodeEntries = <T>(bytes: Uint8Array, value: MessageSpec): Record<string, T> => {
  const reader = new Reader(bytes)
  const entries: Record<string, T> = {}

  while (reader.pos < bytes.length) {
    const tag = reader.varint()
    if (tag >>> 3 !== 1) {
      reader.skip(tag & 7)
      continue
    }

    const end = reader.varint() + reader.pos
    let key = 0
    let entry: unknown = null
    while (reader.pos < end) {
      const entryTag = reader.varint()
      if (entryTag >>> 3 === 1) key = reader.int32()
      else if (entryTag >>> 3 === 2) entry = decodeMessage(reader, reader.varint() + reader.pos, value)
      else reader.skip(entryTag & 7)
    }
    entries[key] = entry as T
  }

  return entries
}
