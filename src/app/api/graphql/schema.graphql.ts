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
// Rows additionally carry ENTITY EDGES (`owner`, `type`, `location`) so the
// GraphiQL docs explorer at GET /api/graphql is navigable — clicking through
// Asset → ItemType is how you discover that group/category/volume exist at all.
// Two invariants keep the edges from costing what nested resolvers usually
// cost, both pinned by test/graphqlSchema.test.ts:
//
//  1. THE ENTITY TYPES ARE LEAF-ONLY. Owner, ItemType and Location contain
//     scalars and nothing else, so a response is at most row → entity → scalar.
//     Every row therefore flattens to exactly one CSV line (owner { name }
//     becomes an owner_name column) — see src/app/graphql/flatten.ts, which the
//     /graphql page's "Copy as CSV" uses. There is no deep-query surface.
//  2. NO EDGE FANS OUT PER ROW. `type` and `location` are pure reshapes of data
//     the root resolver already fetched (it was resolving names from the full
//     SDE rows and throwing the rest away). Owner's corp/alliance fields are the
//     one exception that reads: they load lazily and once per result set, memoed
//     on the scope array in context.ts.
//
// Every entity field is ALSO reachable as a flat scalar on the row itself
// (ownerName beside owner { name }, typeName beside type { name }). Pick the
// scalars for a CSV-shaped query, the edges for exploring; both cost the same.
export const typeDefs = /* GraphQL */ `
  type Query {
    "Your linked characters. ownerId on every row below is one of these ids."
    owners: [Owner!]!

    """
    Current asset rows (live inventory) across your characters. typeIds filters
    on exact SDE type ids; typeName is a fuzzy name search — pass one or the
    other, never both. includeShared additionally returns rows other users have
    shared with you (session auth only — the api_token path is own-data only; a
    Lens is the way to hand shared data to external tools).
    """
    assets(
      typeIds: [String!]
      typeName: String
      locationId: String
      owner: String
      limit: Int
      includeShared: Boolean = false
    ): AssetPage!

    "Asset shares other users have aimed at you (corporation/alliance/public). Session auth only."
    sharedWithMe: [ShareGrant!]!

    "Current blueprint rows (BPOs and BPCs) across your characters. typeIds and typeName are mutually exclusive."
    blueprints(typeIds: [String!], typeName: String, owner: String, limit: Int): BlueprintPage!

    "Open market orders across your characters."
    marketOrders(owner: String): [MarketOrder!]!

    "Industry jobs across your characters. Delivered jobs are excluded unless includeDelivered."
    industryJobs(owner: String, includeDelivered: Boolean = false): [IndustryJob!]!

    "Latest known wallet balance per character."
    walletBalances: [WalletBalance!]!

    "Market transaction history across your characters, newest first. typeIds and typeName are mutually exclusive."
    walletTransactions(
      typeIds: [String!]
      typeName: String
      owner: String
      since: String
      limit: Int
    ): [WalletTransaction!]!
  }

  """
  The character a row belongs to. Reached as \`owner\` from every row type, and
  listed on its own by the \`owners\` query. Leaf-only, so \`owner { … }\` still
  flattens to one CSV line.

  \`id\` is this site's registration id (the id \`ownerId\` carries and the
  \`owner:\` filter matches on), NOT the EVE character id — that's
  \`characterId\`. The corp/alliance fields load only when you select them.
  """
  type Owner {
    "This site's registration id — what ownerId carries and the owner: filter matches. NOT the EVE character id."
    id: String!
    "The character's name, and what the owner: filter accepts."
    name: String!
    "The EVE character id (what zKillboard, ESI and the image server use)."
    characterId: String
    corporationId: String
    corporationName: String
    allianceId: String
    "Null for a character whose corporation is in no alliance."
    allianceName: String
  }

  """
  An EVE item type from the SDE mirror, reached as \`type\` (or
  \`blueprintType\`/\`productType\`) from every row that names an item.
  Leaf-only. Nothing here needs an extra query — the row's \`typeName\` was
  already read from these same SDE rows.
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
    ownerId: String!
    ownerName: String!
    sharedAt: String!
    "The sharing character."
    owner: Owner!
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
    ownerId: String!
    ownerName: String!
    owner: Owner!
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
    ownerId: String!
    ownerName: String!
    owner: Owner!
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
    price: Float!
    volumeTotal: String!
    volumeRemain: String!
    minVolume: String
    escrow: Float
    range: String!
    duration: Int!
    issued: String!
    ownerId: String!
    ownerName: String!
    owner: Owner!
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
    ownerId: String!
    ownerName: String!
    owner: Owner!
    blueprintType: ItemType!
    "Null for research and copy jobs, which produce no new item type."
    productType: ItemType
    "The facility the job runs in — stationId when ESI gave one, else the structure."
    location: Location
  }

  type WalletBalance {
    ownerId: String!
    ownerName: String!
    balance: Float!
    recordedAt: String!
    owner: Owner!
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
    ownerId: String!
    ownerName: String!
    owner: Owner!
    type: ItemType!
    location: Location!
  }
`
