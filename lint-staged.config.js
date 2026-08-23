import path from 'node:path'

// `docs/` holds vendored artifacts (design-tool exports, bundled JS/HTML) that
// neither formatter should touch: prettier --write reformats them out of the
// shape the exporter produced, and `.oxlintrc.json` ignores `docs/**` outright —
// which makes `oxlint --fix` exit 1 with "No files found to lint" when every
// staged file it was handed is ignored. Drop them before building the commands.
const isVendoredDoc = (file) => {
  const rel = path.relative(process.cwd(), file)
  return rel === 'docs' || rel.startsWith(`docs${path.sep}`)
}

const runOn = (bin) => (files) => {
  const targets = files.filter((file) => !isVendoredDoc(file))
  return targets.length ? [`${bin} ${targets.map((f) => JSON.stringify(f)).join(' ')}`] : []
}

const config = {
  '**/*.{json,html}': runOn('prettier --write'),
  '**/*.{ts,tsx,js,jsx,json}': [runOn('prettier --write'), runOn('oxlint --fix')],
}

export default config
