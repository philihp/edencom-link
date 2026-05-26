# Workflow

- Before committing to a new feature branch, check what branch it branched from and rebase onto the latest upstream of that base (typically `origin/main`) first. This avoids opening PRs that include changes already merged on the base.

# Architecture

- Data from ESI flows into the database (typically via the hourly cron job in `src/hourly.js`). The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
