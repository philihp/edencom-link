'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { deleteLens, previewLens, saveLens } from './actions'
import styles from './lens.module.css'

const DEFAULT_QUERY = `{
  assets(type: "Tritanium") {
    totalCount
    rows {
      typeName
      quantity
      locationName
      ownerName
    }
  }
}`

type LensEditorProps = {
  // null = the create-new editor; otherwise the lens being edited.
  lens: { id: string; name: string; query: string; variables: string } | null
}

// Create/edit form for one lens: name, query, fixed variables, a run-as-me
// preview (server action under the caller's own context — the same result the
// audience will see), save, and delete. Sharing lives in the ShareDialog the
// server component renders beside this.
export const LensEditor = ({ lens }: LensEditorProps) => {
  const router = useRouter()
  const [open, setOpen] = useState(lens === null)
  const [name, setName] = useState(lens?.name ?? '')
  const [query, setQuery] = useState(lens?.query ?? DEFAULT_QUERY)
  const [variables, setVariables] = useState(lens?.variables ?? '')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const save = () =>
    startTransition(async () => {
      setError(null)
      const saved = await saveLens(lens?.id ?? null, { name, query, variables })
      if (saved.error) setError(saved.error)
      else {
        if (lens === null) {
          setName('')
          setQuery(DEFAULT_QUERY)
          setVariables('')
          setResult('')
          setOpen(false)
        }
        router.refresh()
      }
    })

  const preview = () =>
    startTransition(async () => {
      setError(null)
      const ran = await previewLens({ query, variables })
      if (ran.error) setError(ran.error)
      else setResult(ran.result ?? '')
    })

  const remove = () =>
    startTransition(async () => {
      setError(null)
      const removed = await deleteLens(lens!.id)
      if (removed.error) setError(removed.error)
      else router.refresh()
    })

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {lens === null ? 'New lens' : 'Edit'}
      </button>
    )
  }

  return (
    <div className={styles.editor}>
      <label className={styles.field}>
        Name
        <input className={styles.name} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={styles.field}>
        Query (one top-level field)
        <textarea
          className={styles.query}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={12}
          spellCheck={false}
        />
      </label>
      <label className={styles.field}>
        Variables (JSON, fixed — viewers can&apos;t change them)
        <textarea
          className={styles.variables}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          rows={2}
          spellCheck={false}
        />
      </label>
      <div className={styles.buttons}>
        <button type="button" onClick={save} disabled={pending || name.trim() === '' || query.trim() === ''}>
          {pending ? 'Working…' : 'Save'}
        </button>
        <button type="button" onClick={preview} disabled={pending || query.trim() === ''}>
          Preview
        </button>
        {lens !== null && (
          <>
            <button type="button" onClick={remove} disabled={pending}>
              Delete
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Close
            </button>
          </>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {result !== '' && <pre className={styles.result}>{result}</pre>}
    </div>
  )
}
