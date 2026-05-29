# Workflow

- Before committing to a new feature branch, check what branch it branched from and rebase onto the latest upstream of that base (typically `origin/main`) first. This avoids opening PRs that include changes already merged on the base.

# Data sources

- NEVER query the `evesde` SDE schema in the database. That data is out of date and must not be used for any work. Resolve type/name lookups via the external API helper in `src/app/typeNames.ts` (`fetchTypeNames`) instead. If a needed lookup has no non-SDE source, show the raw ID rather than reading the SDE.

# Architecture

- Data from ESI flows into the database (typically via the hourly cron job in `src/hourly.js`). The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
