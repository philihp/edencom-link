import styles from './auth.module.css'

// A result line on a sign-on form: a dot in the status color plus the message,
// both taking their color from `kind` so the two stay in step. The sign-on
// equivalent of the account area's <Dot color="#FF0000">, but themed — see the
// --ok / --danger custom properties in globals.css.
//
// `inline` tightens the spacing for a line that sits under its own field (the
// invite-code lookup) rather than under the whole form.
const Status = ({ kind, inline, children }: { kind: 'ok' | 'error'; inline?: boolean; children: React.ReactNode }) => (
  <p className={`${styles.status} ${inline ? styles.statusInline : ''} ${styles[kind]}`}>
    <span className={styles.dot} />
    <span>{children}</span>
  </p>
)

export default Status
