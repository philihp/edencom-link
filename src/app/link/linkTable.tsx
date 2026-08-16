import { linkRows } from './flatten'
import styles from './link.module.css'

// The result table the viewer page and the editor's preview both render — one
// flattening (linkRows), one look. No hooks, so it serves server and client
// components alike.
export const LinkTable = ({ data }: { data: unknown }) => {
  const rows = linkRows(data)
  // The relay reports a readiness gap rather than an absence — but the first
  // clause still says plainly that the query matched nothing.
  if (rows.length === 0)
    return (
      <p className={styles.note}>No records returned. Nothing registered against this query. This has been logged.</p>
    )
  const headers = Object.keys(rows[0])
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {headers.map((h) => (
                <td key={h}>{row[h] == null ? '' : String(row[h])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
