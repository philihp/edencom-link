// Dynamic, item-specific names — a thing's name or title — render in the serif
// face (see the typography note in globals.css). These thin components wrap the
// resolver-map lookups each page already performs, applying that face in one
// place plus a consistent fallback: the numeric `#id` when a name hasn't
// resolved yet, or `—` when there is nothing to show.
//
// Pair with the existing self-serif primitives: `TypeName` (async type lookup)
// and `DateTime` (timestamps). For one-off dynamic text that isn't an entity
// name (a countdown, an activity label), use the `.serif` utility class directly.

type NameProps = {
  name?: string | null
  /** Shown as `#id` when `name` is missing; omit to fall back to `—`. */
  id?: string | number | null
}

export const Name = ({ name, id }: NameProps) => <span className="serif">{name ?? (id != null ? `#${id}` : '—')}</span>

// Characters fall back to `—`: their id is an opaque uuid, not worth showing.
export const CharacterName = ({ name }: { name?: string | null }) => <Name name={name} />

export const SystemName = (props: NameProps) => <Name {...props} />

export const StationName = (props: NameProps) => <Name {...props} />
