// The GraphQL SDL for /api/graphql, kept in a module with no I/O imports so
// the node test runner can assert its shape (test/graphqlSchema.test.ts)
// without dragging in Next or Supabase.
//
// Design stance: a flat schema — every list is a root Query field returning
// fully-materialized rows, with names (typeName/locationName/ownerName)
// resolved in the root resolver, batched once per result set. Ids are String:
// EVE item ids exceed 2^53, and GraphQL Int is 32-bit. Timestamps are ISO 8601
// strings.
//
// Rows additionally carry ENTITY EDGES (`character`/`corporation`, `type`,
// `location`) so the
// GraphiQL docs explorer at GET /api/graphql is navigable — clicking through
// Asset → ItemType is how you discover that group/category/volume exist at all.
// Two invariants keep the edges from costing what nested resolvers usually
// cost, both pinned by test/graphqlSchema.test.ts:
//
//  1. THE ENTITY TYPES ARE LEAF-ONLY. Character, Corporation, ItemType and
//     Location contain scalars and nothing else, so a response is at most
//     row → entity → scalar. Every row therefore flattens to exactly one CSV
//     line (character { name } becomes a character_name column) — see
//     src/app/lens/flatten.ts, which the /graphql page's "Copy as CSV" uses.
//     There is no deep-query surface.
//  2. NO EDGE FANS OUT PER ROW. `type` and `location` are pure reshapes of data
//     the root resolver already fetched (it was resolving names from the full
//     SDE rows and throwing the rest away). The corp/alliance fields on
//     Character and Corporation are the one exception that reads: they load
//     lazily and once per result set, memoed in context.ts.
//
// Every entity field is ALSO reachable as a flat scalar on the row itself
// (characterName beside character { name }, typeName beside type { name }).
// Pick the scalars for a CSV-shaped query, the edges for exploring; both cost
// the same. WHO OWNS A ROW is spelled out flat: ownerType says character or
// corporation, characterId/characterName and corporationId/corporationName are
// each filled only on their own side, and ownerId/ownerName coalesce the two.
//
// FILTERS COME IN SINGULAR/PLURAL PAIRS: owner/owners, location/locations,
// type/types. An OWNER is a character or a corporation — one dimension, since
// a row is owned by one or the other and asking "what do these own" shouldn't
// care which. The singular is a
// case-insensitive substring SEARCH over names; the plural is an EXACT list
// whose entries are ids or whole names, mixed freely. The two are mutually
// exclusive, an entry matching nothing is an error, and each entity type's
// description says which of its fields the pair accepts. See filters.ts.
export const typeDefs = /* GraphQL */ `
  type Query {
    "Your linked characters — what characterId/characterName on a row below name, and what an owner filter accepts."
    characters: [Character!]!

    "The corporations your linked characters belong to — what corporationId/corporationName on a corp-owned row name, and what an owner filter accepts."
    corporations: [Corporation!]!

    """
    Current asset rows (live inventory) across your characters AND the
    corporations they belong to. Filters are the schema's singular/plural pairs
    — type/types, location/locations, owner/owners, where an owner is a
    character OR a corporation (see Owner and Corporation). includeShared
    additionally
    returns rows other users have shared with you (session auth only — the
    api_token path is own-data only; a Lens is the way to hand shared data to
    external tools).
    """
    assets(
      type: String
      types: [String!]
      location: String
      locations: [String!]
      owner: String
      owners: [String!]
      limit: Int
      includeShared: Boolean = false
    ): AssetPage!

    """
    A restock (shopping) list. You give TARGETS — an item type and the quantity
    you want on hand — and each line sums your current stacks of that type
    (across your characters AND their corporations, like assets) and reports
    what you're missing. location/locations and owner/owners narrow which
    hangars count as "on hand", exactly as they do on assets; the types come
    from the targets, so there is no type filter here.

    By default only lines below target come back; onlyBelowTarget: false keeps
    every target, including the covered ones.
    """
    restock(
      targets: [RestockTarget!]!
      location: String
      locations: [String!]
      owner: String
      owners: [String!]
      onlyBelowTarget: Boolean = true
    ): [RestockLine!]!

    "Asset shares other users have aimed at you (corporation/alliance/public). Session auth only."
    sharedWithMe: [ShareGrant!]!

    "Current blueprint rows (BPOs and BPCs) across your characters and their corporations, filtered by item type and owner."
    blueprints(type: String, types: [String!], owner: String, owners: [String!], limit: Int): BlueprintPage!

    "Open market orders. Character-owned only: corp market orders are not extracted yet, so an owner filter naming only corporations is refused here rather than silently returning nothing."
    marketOrders(owner: String, owners: [String!]): [MarketOrder!]!

    "Industry jobs across your characters and their corporations. Delivered jobs are excluded unless includeDelivered."
    industryJobs(owner: String, owners: [String!], includeDelivered: Boolean = false): [IndustryJob!]!

    "Latest known wallet balance per character."
    walletBalances: [WalletBalance!]!

    "Market transaction history across your characters, newest first. Character-owned only, like marketOrders."
    walletTransactions(
      type: String
      types: [String!]
      owner: String
      owners: [String!]
      since: String
      limit: Int
    ): [WalletTransaction!]!
  }

  """
  A character that owns rows, reached as \`character\` from every row type and
  listed on its own by the \`characters\` query. Leaf-only, so
  \`character { … }\` still flattens to one CSV line. Null on a row a
  CORPORATION owns — see Corporation.

  The row already carries \`characterId\`/\`characterName\` as flat columns; this
  edge is for the rest — the registration \`id\`, and the corp/alliance the
  character belongs to (which is NOT the row's owner unless \`ownerType\` says
  corporation). Those load only when you select them.

  FILTERS: the \`owner:\`/\`owners:\` pair spans characters and corporations
  alike. \`owner:\` is a case-insensitive substring of either's \`name\`;
  \`owners:\` is an exact list whose entries may be any of the three ids on this
  type — a whole \`name\`, an EVE \`characterId\`, or a registration \`id\` —
  mixed freely with the corporation forms. An entry that matches nothing is an
  error, never a silently narrower result.
  """
  type Character {
    "This site's registration id — one of the forms an owner filter accepts. NOT the EVE character id."
    id: String!
    "The character's name, as the row's characterName carries it."
    name: String!
    "The EVE character id (what zKillboard, ESI and the image server use), as the row's characterId carries it."
    characterId: String
    "The corporation this CHARACTER belongs to — not the row's owner."
    corporationId: String
    corporationName: String
    allianceId: String
    "Null for a character whose corporation is in no alliance."
    allianceName: String
  }

  """
  The corporation that owns a row, reached as \`corporation\` from the row types
  a corporation can own (assets, blueprints and industry jobs — the ones with
  a corp-wide ESI endpoint). Leaf-only, like Character. Null on a row a
  CHARACTER owns; the row's \`corporationId\`/\`corporationName\` carry the flat
  columns, and \`ownerId\`/\`ownerName\` coalesce the two sides so a CSV always
  has one filled owner column.

  Only corporations your own characters belong to ever appear here — corp rows
  are scoped to exactly that set.

  FILTERS: the same \`owner:\`/\`owners:\` pair reaches a corporation by whole
  \`name\` or \`corporationId\`. Naming one side narrows to it: an owner filter
  that matched only corporations drops character-owned rows, one that matched
  only characters drops corp-owned rows, one matching both unions them, and no
  filter returns both.
  """
  type Corporation {
    "The EVE corporation id — what ownerId carries on a corp-owned row."
    corporationId: String!
    name: String
    allianceId: String
    "Null for a corporation in no alliance."
    allianceName: String
  }

  """
  An EVE item type from the SDE mirror, reached as \`type\` (or
  \`blueprintType\`/\`productType\`) from every row that names an item.
  Leaf-only. Nothing here needs an extra query — the row's \`typeName\` was
  already read from these same SDE rows.

  FILTERS: \`type:\` searches \`name\` the way the site's item search does, and
  keeps everything it matched (so "Fuel Block" catches all four, and the
  blueprints); it refuses a term matching too many types to be a filter.
  \`types:\` is an exact list of \`typeId\`s and whole \`name\`s, mixed.
  """
  type ItemType {
    typeId: String!
    name: String
    groupId: String
    "e.g. \\"Mineral\\", \\"Frigate\\" — the SDE group, one level under the category."
    groupName: String
    categoryId: String
    "e.g. \\"Ship\\", \\"Blueprint\\", \\"Module\\" — the broadest SDE bucket."
    categoryName: String
    "Tech/faction tier (T2, faction, officer, …); null on plain T1 types, which the SDE doesn't stamp."
    metaGroupId: String
    "m³ per unit — the ASSEMBLED figure for ships and other singletons; the SDE carries no packaged volume."
    volume: Float
  }

  """
  Where a row sits, reached as \`location\`. Leaf-only. The name resolves the
  same way the asset pages do: your own corp's structures beat the ESI-resolved
  structure cache, NPC stations and systems come from the universe_name cache,
  and anything unresolvable falls back to a \`#id\` label.

  \`systemId\`/\`systemName\` are the solar system the location is in — null for a
  container or ship whose own location we couldn't walk up to a system.

  FILTERS: \`location:\` substring-searches names across all three sources at
  once — your corp's structures, the ESI-resolved structure cache, NPC stations
  and solar systems — and keeps every id it matched, so a system name pulls in
  that system's rows and a station name that station's. \`locations:\` is an
  exact list of \`locationId\`s and whole names, mixed. Neither widens what you
  can read: a name you don't own resolves to an id none of your rows carry.
  """
  type Location {
    locationId: String!
    name: String
    systemId: String
    systemName: String
  }

  "An asset share another user has aimed at you; itemId is the shared root (a ship or container), covering everything inside it."
  type ShareGrant {
    shareId: String!
    itemId: String!
    itemTypeName: String
    sharedAt: String!
    "Always character here — a share always comes from a character."
    ownerType: String!
    "Same as characterId. The coalesced owner id every row type carries."
    ownerId: String!
    "Same as characterName. The coalesced owner name every row type carries."
    ownerName: String!
    "The sharing character's EVE id."
    characterId: String
    "The sharing character's name."
    characterName: String
    "The sharing character, for its registration id and corp/alliance."
    character: Character
    "The shared root's item type."
    itemType: ItemType
  }

  type Asset {
    itemId: String!
    typeId: String!
    typeName: String
    quantity: String!
    locationId: String
    locationFlag: String
    locationType: String
    locationName: String
    isSingleton: Boolean
    isBlueprintCopy: Boolean
    "Player-assigned name (ship/container custom name), if any."
    name: String
    "Either character or corporation — which side owns this row."
    ownerType: String!
    "characterId or corporationId, whichever this row has — always filled."
    ownerId: String!
    "characterName or corporationName, whichever this row has — always filled."
    ownerName: String!
    "The owning character's EVE id; null when a corporation owns the row."
    characterId: String
    "The owning character's name; null when a corporation owns the row."
    characterName: String
    "The owning corporation's EVE id; null when a character owns the row."
    corporationId: String
    "The owning corporation's name; null when a character owns the row."
    corporationName: String
    "The owning character, for its registration id and corp/alliance; null on a corp-owned row."
    character: Character
    "The owning corporation, for its alliance; null on a character-owned row."
    corporation: Corporation
    type: ItemType!
    "Null only for a row ESI gave no location_id."
    location: Location
  }

  type AssetPage {
    rows: [Asset!]!
    "Rows matching the filters, before the limit."
    totalCount: Int!
    truncated: Boolean!
  }

  """
  One entry of a restock list: an item type and how many of it you want on
  hand. Like an entry of a \`types:\` list, \`type\` is an SDE typeId or a WHOLE
  item name (case-insensitive) — a name matching nothing, or matching two
  types at once, is an error rather than a line summed over the wrong
  denominator. Naming the same type twice is an error for the same reason.
  """
  input RestockTarget {
    type: String!
    "How many you want on hand. A whole number above zero, up to 2147483647 — GraphQL Int is 32-bit."
    quantity: Int!
  }

  """
  One line of a restock list. This is the schema's one AGGREGATE row — it sums
  stacks — so unlike every other row type it carries no owner block: "on hand"
  may span two of your characters and a corp hangar at once, and there'd be no
  single owner to name. Narrow with \`owner:\` to ask per owner instead.

  Leaf-only apart from the \`type\` edge, so a line still flattens to one CSV
  line like every other row.
  """
  type RestockLine {
    typeId: String!
    typeName: String
    "e.g. \\"Mineral\\", \\"Fuel Block\\" — handy for grouping a shopping list."
    groupName: String
    "The quantity you asked for, as given in targets."
    target: String!
    "Sum of your matching stacks of this type, under the filters given."
    onHand: String!
    "onHand - target: NEGATIVE when you're short, positive when overstocked."
    delta: String!
    "max(0, target - onHand) — the number to buy, never negative."
    toBuy: String!
    type: ItemType!
  }

  type Blueprint {
    itemId: String!
    typeId: String!
    typeName: String
    quantity: String!
    locationId: String
    locationFlag: String
    locationName: String
    materialEfficiency: Int
    timeEfficiency: Int
    "-1 for an original, remaining licensed runs for a copy."
    runs: Int
    "Either character or corporation — which side owns this row."
    ownerType: String!
    "characterId or corporationId, whichever this row has — always filled."
    ownerId: String!
    "characterName or corporationName, whichever this row has — always filled."
    ownerName: String!
    "The owning character's EVE id; null when a corporation owns the row."
    characterId: String
    "The owning character's name; null when a corporation owns the row."
    characterName: String
    "The owning corporation's EVE id; null when a character owns the row."
    corporationId: String
    "The owning corporation's name; null when a character owns the row."
    corporationName: String
    "The owning character, for its registration id and corp/alliance; null on a corp-owned row."
    character: Character
    "The owning corporation, for its alliance; null on a character-owned row."
    corporation: Corporation

    "The blueprint's own item type — the product's type is not on this row."
    type: ItemType!
    location: Location
  }

  type BlueprintPage {
    rows: [Blueprint!]!
    totalCount: Int!
    truncated: Boolean!
  }

  type MarketOrder {
    orderId: String!
    typeId: String!
    typeName: String
    locationId: String!
    locationName: String
    regionId: String!
    isBuy: Boolean!
    "Placed on behalf of the character's corporation (ESI's flag; the order still rides the character's extract)."
    isCorporation: Boolean!
    price: Float!
    volumeTotal: String!
    volumeRemain: String!
    minVolume: String
    escrow: Float
    range: String!
    duration: Int!
    issued: String!
    "Always character here — nothing else can own this row."
    ownerType: String!
    "Same as characterId. The coalesced owner id every row type carries."
    ownerId: String!
    "Same as characterName. The coalesced owner name every row type carries."
    ownerName: String!
    "The owning character's EVE id."
    characterId: String
    "The owning character's name."
    characterName: String
    "The owning character, for its registration id and corp/alliance."
    character: Character
    type: ItemType!
    location: Location!
  }

  type IndustryJob {
    jobId: String!
    activityId: Int!
    blueprintTypeId: String!
    blueprintTypeName: String
    productTypeId: String
    productTypeName: String
    runs: Int!
    licensedRuns: Int
    probability: Float
    successfulRuns: Int
    status: String!
    cost: Float
    duration: Int!
    startDate: String!
    endDate: String!
    completedDate: String
    stationId: String
    locationName: String
    "Either character or corporation — which side owns this row."
    ownerType: String!
    "characterId or corporationId, whichever this row has — always filled."
    ownerId: String!
    "characterName or corporationName, whichever this row has — always filled."
    ownerName: String!
    "The owning character's EVE id; null when a corporation owns the row."
    characterId: String
    "The owning character's name; null when a corporation owns the row."
    characterName: String
    "The owning corporation's EVE id; null when a character owns the row."
    corporationId: String
    "The owning corporation's name; null when a character owns the row."
    corporationName: String
    "The owning character, for its registration id and corp/alliance; null on a corp-owned row."
    character: Character
    "The owning corporation, for its alliance; null on a character-owned row."
    corporation: Corporation

    "The EVE character who installed a CORP job; null on a character's own job, which ESI doesn't stamp."
    installerId: String
    "The blueprint ITEM the job consumes — the physical copy or original, not its type."
    blueprintId: String!
    "Where the blueprint item sat when the job was installed."
    blueprintLocationId: String!
    "Where the job's output will be delivered."
    outputLocationId: String!
    "ESI's raw facility id — stationId when the job runs in an NPC station, else the structure id (see also location)."
    facilityId: String!
    "When the job was paused (its facility reinforced); null while it runs."
    pauseDate: String
    "The EVE character who delivered the job; null until someone does."
    completedCharacterId: String
    blueprintType: ItemType!
    "Null for research and copy jobs, which produce no new item type."
    productType: ItemType
    "The facility the job runs in — stationId when ESI gave one, else the structure."
    location: Location
  }

  type WalletBalance {
    balance: Float!
    recordedAt: String!
    "Always character here — nothing else can own this row."
    ownerType: String!
    "Same as characterId. The coalesced owner id every row type carries."
    ownerId: String!
    "Same as characterName. The coalesced owner name every row type carries."
    ownerName: String!
    "The owning character's EVE id."
    characterId: String
    "The owning character's name."
    characterName: String
    "The owning character, for its registration id and corp/alliance."
    character: Character
  }

  type WalletTransaction {
    transactionId: String!
    date: String!
    typeId: String!
    typeName: String
    quantity: String!
    unitPrice: Float!
    isBuy: Boolean!
    locationId: String!
    locationName: String
    "Always character here — nothing else can own this row."
    ownerType: String!
    "Same as characterId. The coalesced owner id every row type carries."
    ownerId: String!
    "Same as characterName. The coalesced owner name every row type carries."
    ownerName: String!
    "The owning character's EVE id."
    characterId: String
    "The owning character's name."
    characterName: String
    "The owning character, for its registration id and corp/alliance."
    character: Character
    type: ItemType!
    location: Location!
  }
`
