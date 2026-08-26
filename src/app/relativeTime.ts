// "in 3 months 13 days" — a coarse, human-scale distance to a future moment,
// paired with the exact DateTime it qualifies. Two units, the largest that
// apply, and the second dropped when it is zero ("in 2 weeks"). Months are
// calendar months stepped from the anchor (a month is not 30 days), weeks are
// seven days. Pure and fed both instants by the caller: /structure computes it
// in the server component, so the string is fixed HTML and hydration has
// nothing to disagree with.
const DAY = 86_400_000

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

export const formatRelativeFuture = (target: string | Date, now: Date): string | null => {
  const to = target instanceof Date ? target : new Date(target)
  if (Number.isNaN(to.getTime()) || to <= now) return null

  // Whole calendar months from `now`, stepping so "Jan 31 + 1 month" clamps
  // rather than overshooting into March.
  let months = (to.getUTCFullYear() - now.getUTCFullYear()) * 12 + (to.getUTCMonth() - now.getUTCMonth())
  const stepMonths = (n: number) => {
    const d = new Date(now)
    const day = d.getUTCDate()
    d.setUTCDate(1) // step from the 1st so the month arithmetic can't overflow
    d.setUTCMonth(d.getUTCMonth() + n)
    // Clamp to the target month's last day: Jan 31 + 1 month is Feb 28, not
    // the Mar 3 that JS's rolling setUTCMonth would produce.
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, lastDay))
    return d
  }
  while (months > 0 && stepMonths(months) > to) months -= 1

  if (months >= 1) {
    const days = Math.floor((to.getTime() - stepMonths(months).getTime()) / DAY)
    return days > 0 ? `in ${plural(months, 'month')} ${plural(days, 'day')}` : `in ${plural(months, 'month')}`
  }

  const totalDays = Math.floor((to.getTime() - now.getTime()) / DAY)
  if (totalDays >= 7) {
    const weeks = Math.floor(totalDays / 7)
    const days = totalDays % 7
    return days > 0 ? `in ${plural(weeks, 'week')} ${plural(days, 'day')}` : `in ${plural(weeks, 'week')}`
  }
  if (totalDays >= 1) {
    const hours = Math.floor(((to.getTime() - now.getTime()) % DAY) / 3_600_000)
    return hours > 0 ? `in ${plural(totalDays, 'day')} ${plural(hours, 'hour')}` : `in ${plural(totalDays, 'day')}`
  }
  const totalHours = Math.floor((to.getTime() - now.getTime()) / 3_600_000)
  return totalHours >= 1 ? `in ${plural(totalHours, 'hour')}` : 'in under an hour'
}
