// A plain GET form — the browser handles the navigation to /asset/search, so
// this needs no client-side JS.
import styles from './assets.module.css'

export const AssetSearchForm = ({ initialQuery = '' }: { initialQuery?: string }) => (
  <form action="/asset/search" method="get" className={styles.searchForm}>
    <input
      type="text"
      name="q"
      defaultValue={initialQuery}
      placeholder='Item name, e.g. "ftl interlink"…'
      aria-label="Search item name"
    />
    <button type="submit">Search</button>
  </form>
)
