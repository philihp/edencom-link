const config = {
  '**/*.{json,html}': ['prettier --write'],
  '**/*.{ts,tsx,js,jsx,json}': ['prettier --write', 'oxlint --fix'],
}

export default config
