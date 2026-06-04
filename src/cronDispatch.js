// Dispatches a cron job to the Vercel API route. Requires VERCEL_APP_URL and
// CRON_SECRET to be set; throws if either is missing or the request fails.
export const dispatchCronJob = async (job) => {
  const vercelUrl = process.env.VERCEL_APP_URL
  const cronSecret = process.env.CRON_SECRET
  if (!vercelUrl || !cronSecret) throw new Error(`VERCEL_APP_URL and CRON_SECRET must be set to dispatch "${job}"`)

  const res = await fetch(`${vercelUrl}/api/cron/${job}`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(65_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Vercel dispatch for "${job}" failed: HTTP ${res.status} ${body}`)
  }
  console.log(`[dispatch] ${job} completed via Vercel (${res.status})`)
}
