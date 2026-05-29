# Workflow

- Before committing to a new feature branch, check what branch it branched from and rebase onto the latest upstream of that base (typically `origin/main`) first. This avoids opening PRs that include changes already merged on the base.

# Architecture

- Data from ESI flows into the database (typically via the hourly cron job in `src/hourly.js`). The UI then reads from the database. The UI/Next.js server components must never call ESI directly.
- Avoid using the `evesde` schema in the database for new work — it can be out of date. Instead, query [eve-build-calculator](https://eve-build-calculator.philihp.com) (e.g. the `https://eve-build-calculator.philihp.com/api/type/${typeID}` pattern in `src/app/typeNames.ts`). It downloads the full SDE but only saves/exposes a curated subset. If the data you need isn't exposed there yet, prefer adding it to eve-build-calculator rather than reaching into the `evesde` schema.
