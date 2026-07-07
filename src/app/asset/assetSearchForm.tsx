// A plain GET form — the browser handles the navigation to /asset/search, so
// this needs no client-side JS. An unchecked checkbox submits no value at
// all, so the default (no `blueprints` param) is "exclude blueprints" with no
// extra logic needed on the reading end beyond checking for its presence.
import styles from './assets.module.css'

type AssetSearchFormProps = {
  initialQuery?: string
  initialIncludeBlueprints?: boolean
}

export const AssetSearchForm = ({ initialQuery = '', initialIncludeBlueprints = false }: AssetSearchFormProps) => (
  <form action="/asset/search" method="get" className={styles.searchForm}>
    <input
      type="text"
      name="q"
      defaultValue={initialQuery}
      placeholder='Item name, e.g. "ftl interlink"…'
      aria-label="Search item name"
    />
    <button type="submit">Search</button>
    <label className={styles.searchOption}>
      <input type="checkbox" name="blueprints" value="1" defaultChecked={initialIncludeBlueprints} />
      Include blueprints
    </label>
  </form>
)
