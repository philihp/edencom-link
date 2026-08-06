// The GraphQL SDL for /api/graphql, kept in a module with no I/O imports so
// the node test runner can assert its shape (test/graphqlSchema.test.ts)
// without dragging in Next or Supabase.
//
// Design stance: a flat schema — every list is a root Query field returning
// fully-materialized rows, with names (typeName/locationName/ownerName)
// resolved in the root resolver, batched once per result set. There are no
// nested resolvers, so N+1 fan-out and deep-query abuse are impossible by
// construction. Ids are String: EVE item ids exceed 2^53, and GraphQL Int is
// 32-bit. Timestamps are ISO 8601 strings.
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

  "A linked character (id is this site's registration id, not the EVE character id)."
  type Owner {
    id: String!
    name: String!
  }

  "An asset share another user has aimed at you; itemId is the shared root (a ship or container), covering everything inside it."
  type ShareGrant {
    shareId: String!
    itemId: String!
    itemTypeName: String
    ownerId: String!
    ownerName: String!
    sharedAt: String!
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
  }

  type WalletBalance {
    ownerId: String!
    ownerName: String!
    balance: Float!
    recordedAt: String!
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
  }
`
