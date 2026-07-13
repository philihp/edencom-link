// The single export @eveshipfit/react pulls from @eveshipfit/data. It only
// feeds react's *default* data URL (`https://data.eveship.fit/v${ESF_DATA_VERSION}/`),
// which we override with `<EveDataProvider dataUrl="/esf-data/">`, so the value
// is inert for us — it just has to exist so react's import resolves. Kept equal
// to this stub's package version for readability.
export const ESF_DATA_VERSION = '10.4.20260609'
