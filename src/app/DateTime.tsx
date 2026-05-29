// Standard date/time rendering for the whole app: YYYY-MM-DD HH:MM, 24-hour.
const formatter = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

type DateTimeProps = {
  value: string | number | Date | null | undefined
  fallback?: string
}

export const DateTime = ({ value, fallback = '—' }: DateTimeProps) => {
  if (value === null || value === undefined || value === '') return <>{fallback}</>
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return <>{fallback}</>
  return <time dateTime={date.toISOString()}>{formatter.format(date)}</time>
}
