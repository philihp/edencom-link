import { lensRows } from './flatten'
import styles from './lens.module.css'

// The result table the viewer page and the editor's preview both render — one
// flattening (lensRows), one look. No hooks, so it serves server and client
// components alike.
export const LensTable = ({ data }: { data: unknown }) => {
  const rows = lensRows(data)
  if (rows.length === 0) return <p className={styles.note}>No rows.</p>
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
