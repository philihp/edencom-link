// Who holds the ship, as the heading draws them: a name plus the portrait or
// logo CCP's image server serves for them. `portrait` is null when the id
// behind the name couldn't be resolved (a shared ship whose owner is outside
// the caller's registration view and missing from the public directory), in
// which case the name stands alone.
export type ShipOwner = {
  name: string
  portrait: { url: string; kind: 'character' | 'corporation' } | null
}

export const characterPortrait = (characterId: number | string): ShipOwner['portrait'] => ({
  url: `https://images.evetech.net/characters/${characterId}/portrait?size=64`,
  kind: 'character',
})

export const corporationLogo = (corporationId: number | string): ShipOwner['portrait'] => ({
  url: `https://images.evetech.net/corporations/${corporationId}/logo?size=64`,
  kind: 'corporation',
})
