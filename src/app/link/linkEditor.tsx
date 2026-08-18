'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { deleteLink, previewLink, saveLink } from './actions'
import { LinkTable } from './linkTable'
import { LINK_TEMPLATES, type LinkTemplate } from './templates'
import styles from './link.module.css'

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

// A template's labelled fields → the variables JSON the server actions already
// accept — the fields are a friendlier pen for the same ink. Empty fields are
// omitted (that's what makes an optional $owners mean "everything I own");
// list fields split on commas.
const serializeFields = (template: LinkTemplate, values: Record<string, string>): string => {
  const entries: Array<[string, unknown]> = (template.variableFields ?? []).flatMap(
    (field): Array<[string, unknown]> => {
      const raw = (values[field.name] ?? '').trim()
      if (raw === '') return []
      if (field.kind === 'int') {
        const n = Number(raw)
        return Number.isFinite(n) ? [[field.name, Math.floor(n)]] : []
      }
      if (field.kind === 'list') {
        const list = raw
          .split(',')
          .map((e) => e.trim())
          .filter((e) => e !== '')
        return list.length > 0 ? [[field.name, list]] : []
      }
      return [[field.name, raw]]
    }
  )
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries), null, 2) : ''
}

// Seed the fields from the template's example variables, so picking one shows
// a shape that runs (lists joined back to comma-separated text).
const fieldValuesOf = (template: LinkTemplate): Record<string, string> =>
  Object.fromEntries(
    (template.variableFields ?? []).map((f) => {
      const v = template.variables?.[f.name]
      return [f.name, Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)]
    })
  )

type LinkEditorProps = {
  // null = the create-new editor; otherwise the link being edited.
  link: { id: string; name: string; query: string; variables: string } | null
  // Optional controlled open state, for the Link page, where the Edit toggle
  // sits in the heading's button row and the form opens underneath it rather
  // than inside it. Uncontrolled (its own button) everywhere else.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

type PreviewResult = { data: unknown; errors: string[] }

// Create/edit form for one link: a template picker seeding the query, name,
// the query text, variables (as labelled fields when the active template
// declares them, raw JSON otherwise), a run-as-me preview rendered as the same
// table the viewer page shows, save, and delete. Sharing lives in the
// ShareDialog the server component renders beside this.
export const LinkEditor = ({ link, open: openProp, onOpenChange }: LinkEditorProps) => {
  const router = useRouter()
  const [selfOpen, setSelfOpen] = useState(link === null)
  const open = openProp ?? selfOpen
  const setOpen = onOpenChange ?? setSelfOpen
  const [name, setName] = useState(link?.name ?? '')
  const [query, setQuery] = useState(link?.query ?? DEFAULT_QUERY)
  const [variables, setVariables] = useState(link?.variables ?? '')
  const [template, setTemplate] = useState<LinkTemplate | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const pickTemplate = (id: string) => {
    const picked = LINK_TEMPLATES.find((t) => t.id === id) ?? null
    setTemplate(picked)
    setResult(null)
    if (!picked) return
    const seeded = fieldValuesOf(picked)
    setQuery(picked.query)
    setFieldValues(seeded)
    setVariables(
      picked.variableFields?.length
        ? serializeFields(picked, seeded)
        : picked.variables
          ? JSON.stringify(picked.variables, null, 2)
          : ''
    )
    if (name.trim() === '') setName(picked.label.replace(/ \(Sheets drop-in\)$/, ''))
  }

  const setField = (fieldName: string, value: string) => {
    if (!template) return
    const next = { ...fieldValues, [fieldName]: value }
    setFieldValues(next)
    setVariables(serializeFields(template, next))
  }

  const save = () =>
    startTransition(async () => {
      setError(null)
      const saved = await saveLink(link?.id ?? null, { name, query, variables })
      if (saved.error) setError(saved.error)
      else {
        if (link === null) {
          setName('')
          setQuery(DEFAULT_QUERY)
          setVariables('')
          setTemplate(null)
          setFieldValues({})
          setResult(null)
          setOpen(false)
        }
        router.refresh()
      }
    })

  const preview = () =>
    startTransition(async () => {
      setError(null)
      const ran = await previewLink({ query, variables })
      if (ran.error) setError(ran.error)
      else setResult({ data: ran.data ?? null, errors: ran.errors ?? [] })
    })

  const remove = () =>
    startTransition(async () => {
      setError(null)
      const removed = await deleteLink(link!.id)
      if (removed.error) setError(removed.error)
      else router.refresh()
    })

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {link === null ? 'Register a Link' : 'Edit'}
      </button>
    )
  }

  const fields = template?.variableFields ?? []

  return (
    <div className={styles.editor}>
      <label className={styles.field}>
        Start from a filed query
        <select className={styles.name} value={template?.id ?? ''} onChange={(e) => pickTemplate(e.target.value)}>
          <option value="">Custom query</option>
          {LINK_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {template && <p className={styles.note}>{template.description}</p>}
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
      {fields.length > 0 ? (
        // The template names its variables, so they render as labelled inputs
        // writing through to the same variables JSON the actions accept.
        fields.map((field) => (
          <label key={field.name} className={styles.field}>
            {field.label}
            <input
              className={styles.name}
              value={fieldValues[field.name] ?? ''}
              onChange={(e) => setField(field.name, e.target.value)}
            />
            {field.hint && <span className={styles.note}>{field.hint}</span>}
          </label>
        ))
      ) : (
        <label className={styles.field}>
          Variables (JSON, fixed at registration — whoever the Link is issued to cannot change them)
          <textarea
            className={styles.variables}
            value={variables}
            onChange={(e) => setVariables(e.target.value)}
            rows={2}
            spellCheck={false}
          />
        </label>
      )}
      <div className={styles.buttons}>
        <button type="button" onClick={save} disabled={pending || name.trim() === '' || query.trim() === ''}>
          {pending ? 'Working…' : 'Save'}
        </button>
        <button type="button" onClick={preview} disabled={pending || query.trim() === ''}>
          Preview
        </button>
        {link !== null && (
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
      {result !== null && (
        <>
          {result.errors.length > 0 && <p className={styles.error}>{result.errors.join(' — ')}</p>}
          <LinkTable data={result.data} />
          <details>
            <summary className={styles.note}>Raw result</summary>
            <pre className={styles.result}>{JSON.stringify({ data: result.data }, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  )
}
