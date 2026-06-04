// Returns true if the job was dispatched to Vercel (VERCEL_APP_URL + CRON_SECRET
// are set), false if the caller should run the job locally instead.
// Throws on a non-2xx response so the caller can surface the failure.
export const dispatchCronJob = async (job) => {
  const vercelUrl = process.env.VERCEL_APP_URL
  const cronSecret = process.env.CRON_SECRET
  if (!vercelUrl || !cronSecret) return false

  const res = await fetch(`${vercelUrl}/api/cron/${job}`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(65_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Vercel dispatch for "${job}" failed: HTTP ${res.status} ${body}`)
  }
  console.log(`[dispatch] ${job} completed via Vercel (${res.status})`)
  return true
}
