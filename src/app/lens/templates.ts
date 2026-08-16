// The prewritten lens queries every editing surface offers: the /lens template
// picker, the /graphql example buttons, and the MCP lens_schema examples all
// read this one list, so the three can't drift. Pure data + graphql only —
// test/lensTemplates.test.ts validates every query against the schema and pins
// the drop-in templates' aliases to the legacy CSV routes' column lists.
//
// The seven "Sheets drop-in" templates supersede the api_token CSV routes
// (docs/sharing-layer/09-sheets-parity.md): each aliases its selections to the
// legacy route's snake_case columns IN ORDER, so the lens CSV's header row is
// byte-identical and an existing =IMPORTDATA() tab re-points cleanly. GraphQL
// aliases are what make this template authoring instead of resolver code.
//
// `variableFields` is what the editor renders as labelled inputs instead of
// the raw variables JSON; each names a variable the query declares. `list`
// fields take comma-separated input. Templates whose variables are structured
// (restock targets) declare none and keep the JSON textarea.

export type LensTemplateField = {
  name: string
  label: string
  kind: 'text' | 'int' | 'list'
  // Renders under the input; say what an empty field means when it's optional.
  hint?: string
}

export type LensTemplate = {
  id: string
  label: string
  // One sentence; doubles as the MCP examples' `intent`.
  description: string
  query: string
  variables?: Record<string, unknown>
  variableFields?: LensTemplateField[]
}

// Every drop-in takes an optional $owners: absent reads everything the creator
// owns (characters AND corporations, where the root spans both) — the one
// deliberate difference from the legacy routes, which split the two sides into
// /api/character/* and /api/corp/*. Filling it narrows to named owners.
const OWNERS_FIELD: LensTemplateField = {
  name: 'owners',
  label: 'Owners',
  kind: 'list',
  hint: 'Character or corporation names/ids, comma-separated; empty means everything you own.',
}

export const LENS_TEMPLATES: LensTemplate[] = [
  {
    id: 'sheets-character-assets',
    label: 'Assets (Sheets drop-in)',
    description:
      'Every asset stack you own, with the /api/character/assets CSV columns — point an existing sheet tab at this lens.',
    query: `query Assets($owners: [String!]) {
  assets(owners: $owners) {
    rows {
      is_blueprint_copy: isBlueprintCopy
      is_singleton: isSingleton
      item_id: itemId
      location_flag: locationFlag
      location_id: locationId
      location_type: locationType
      quantity
      type_id: typeId
      character_name: characterName
    }
  }
}`,
    variableFields: [OWNERS_FIELD],
  },
  {
    id: 'sheets-corp-assets',
    label: 'Corp assets (Sheets drop-in)',
    description: 'Corporation asset stacks with the /api/corp/assets CSV columns.',
    query: `query CorpAssets($owners: [String!]) {
  assets(owners: $owners) {
    rows {
      item_id: itemId
      corporation_id: corporationId
      type_id: typeId
      location_id: locationId
      location_flag: locationFlag
      location_type: locationType
      quantity
      is_singleton: isSingleton
      is_blueprint_copy: isBlueprintCopy
    }
  }
}`,
    variableFields: [
      { ...OWNERS_FIELD, hint: 'Your corporation name or id; empty also includes your characters’ own hangars.' },
    ],
  },
  {
    id: 'sheets-character-blueprints',
    label: 'Blueprints (Sheets drop-in)',
    description: 'Blueprint stacks with the /api/character/blueprints CSV columns.',
    query: `query Blueprints($owners: [String!]) {
  blueprints(owners: $owners) {
    rows {
      item_id: itemId
      location_flag: locationFlag
      location_id: locationId
      material_efficiency: materialEfficiency
      quantity
      runs
      time_efficiency: timeEfficiency
      type_id: typeId
      character_name: characterName
    }
  }
}`,
    variableFields: [OWNERS_FIELD],
  },
  {
    id: 'sheets-corp-blueprints',
    label: 'Corp blueprints (Sheets drop-in)',
    description: 'Corporation blueprint stacks with the /api/corp/blueprints CSV columns.',
    query: `query CorpBlueprints($owners: [String!]) {
  blueprints(owners: $owners) {
    rows {
      item_id: itemId
      corporation_id: corporationId
      location_flag: locationFlag
      location_id: locationId
      material_efficiency: materialEfficiency
      quantity
      runs
      time_efficiency: timeEfficiency
      type_id: typeId
    }
  }
}`,
    variableFields: [
      { ...OWNERS_FIELD, hint: 'Your corporation name or id; empty also includes your characters’ own blueprints.' },
    ],
  },
  {
    id: 'sheets-character-orders',
    label: 'Market orders (Sheets drop-in)',
    description: 'Your open market orders with the /api/character/orders CSV columns.',
    query: `query Orders($owners: [String!]) {
  marketOrders(owners: $owners) {
    duration
    escrow
    is_buy_order: isBuy
    is_corporation: isCorporation
    issued
    location_id: locationId
    min_volume: minVolume
    order_id: orderId
    price
    range
    region_id: regionId
    type_id: typeId
    volume_remain: volumeRemain
    volume_total: volumeTotal
    character_name: characterName
  }
}`,
    variableFields: [
      { ...OWNERS_FIELD, hint: 'Character names/ids; empty means all of yours (orders are character-owned).' },
    ],
  },
  {
    id: 'sheets-character-jobs',
    label: 'Industry jobs (Sheets drop-in)',
    description: 'In-flight industry jobs with the /api/character/jobs CSV columns.',
    query: `query Jobs($owners: [String!]) {
  industryJobs(owners: $owners) {
    activity_id: activityId
    blueprint_id: blueprintId
    blueprint_location_id: blueprintLocationId
    blueprint_type_id: blueprintTypeId
    completed_character_id: completedCharacterId
    completed_date: completedDate
    cost
    duration
    end_date: endDate
    facility_id: facilityId
    installer_id: installerId
    job_id: jobId
    licensed_runs: licensedRuns
    output_location_id: outputLocationId
    pause_date: pauseDate
    probability
    product_type_id: productTypeId
    runs
    start_date: startDate
    station_id: stationId
    status
    successful_runs: successfulRuns
    character_name: characterName
    blueprint_type_name: blueprintTypeName
    product_type_name: productTypeName
  }
}`,
    variableFields: [OWNERS_FIELD],
  },
  {
    id: 'sheets-corp-jobs',
    label: 'Corp industry jobs (Sheets drop-in)',
    description: 'Corporation industry jobs with the /api/corp/jobs CSV columns.',
    query: `query CorpJobs($owners: [String!]) {
  industryJobs(owners: $owners) {
    activity_id: activityId
    blueprint_id: blueprintId
    blueprint_location_id: blueprintLocationId
    blueprint_type_id: blueprintTypeId
    completed_character_id: completedCharacterId
    completed_date: completedDate
    corporation_id: corporationId
    cost
    duration
    end_date: endDate
    facility_id: facilityId
    installer_id: installerId
    job_id: jobId
    licensed_runs: licensedRuns
    output_location_id: outputLocationId
    pause_date: pauseDate
    probability
    product_type_id: productTypeId
    runs
    start_date: startDate
    station_id: stationId
    status
    successful_runs: successfulRuns
    blueprint_type_name: blueprintTypeName
    product_type_name: productTypeName
  }
}`,
    variableFields: [
      { ...OWNERS_FIELD, hint: 'Your corporation name or id; empty also includes your characters’ own jobs.' },
    ],
  },
  {
    id: 'wallet-balances',
    label: 'Wallet balances',
    description: 'Every character wallet, one row each.',
    query: `{
  walletBalances {
    ownerName
    balance
    recordedAt
  }
}`,
  },
  {
    id: 'stockpile-by-item',
    label: 'Stockpile by item',
    description: 'Where one item type sits across everything you own.',
    query: `query Stockpile($item: String!) {
  assets(type: $item) {
    totalCount
    truncated
    rows {
      typeName
      quantity
      locationName
      ownerName
    }
  }
}`,
    variables: { item: 'Tritanium' },
    variableFields: [
      { name: 'item', label: 'Item', kind: 'text', hint: 'A name search — "Tritanium" matches wherever it appears.' },
    ],
  },
  {
    // The edges in anger: group/category and the location's solar system are
    // reachable only through `type`/`location`, and each nests exactly one
    // level, so the CSV still gives one line per row (type.groupName,
    // location.systemName, …).
    id: 'stockpile-nested',
    label: 'Stockpile by group (nested)',
    description: 'One item type with its group/category and solar system through the entity edges.',
    query: `{
  assets(type: "Tritanium") {
    rows {
      quantity
      type {
        name
        groupName
        categoryName
        volume
      }
      location {
        name
        systemName
      }
      character {
        name
        corporationName
      }
    }
  }
}`,
  },
  {
    id: 'open-orders',
    label: 'Open orders',
    description: 'Your open market orders, readably named.',
    query: `{
  marketOrders {
    typeName
    isBuy
    price
    volumeRemain
    locationName
    ownerName
  }
}`,
  },
  {
    id: 'industry-jobs',
    label: 'Industry jobs',
    description: 'In-flight industry jobs, readably named.',
    query: `{
  industryJobs {
    blueprintTypeName
    productTypeName
    activityId
    runs
    status
    endDate
    locationName
    ownerName
  }
}`,
  },
  {
    id: 'container-contents',
    label: 'Container contents',
    description: 'Everything sitting in one container or ship, by its item id.',
    query: `query Container($container: [String!]) {
  assets(locations: $container, limit: 500) {
    totalCount
    truncated
    rows {
      itemId
      typeId
      typeName
      quantity
      locationFlag
      ownerName
    }
  }
}`,
    variables: { container: ['1046809423988'] },
    variableFields: [
      {
        name: 'container',
        label: 'Container',
        kind: 'list',
        hint: 'Item ids of containers or ships — a location id also matches what is nested inside it.',
      },
    ],
  },
  {
    id: 'types-anywhere',
    label: 'Certain item types',
    description: 'Only certain item types, wherever they are — e.g. the inputs to a fuel block.',
    query: `query Types($types: [String!]) {
  assets(types: $types, limit: 500) {
    totalCount
    rows {
      typeId
      typeName
      quantity
      locationName
      ownerName
    }
  }
}`,
    variables: { types: ['16273', '17887', '16275', '9832', '44'] },
    variableFields: [{ name: 'types', label: 'Types', kind: 'list', hint: 'SDE type ids or whole item names, mixed.' }],
  },
  {
    id: 'types-in-container',
    label: 'Types in a container',
    description:
      'Both at once: those types, but only inside that container. Variables keep the ids out of the query text.',
    query: `query Stock($container: [String!], $types: [String!]) {
  assets(locations: $container, types: $types, limit: 500) {
    totalCount
    rows {
      typeId
      typeName
      quantity
    }
  }
}`,
    variables: { container: ['1046809423988'], types: ['16273', '17887'] },
  },
  {
    id: 'restock',
    label: 'Restock list',
    description:
      'How much to buy of each item to get back up to a supply buffer. The targets ARE the lens — a viewer cannot change them, so the buffer levels stay yours.',
    query: `query Restock($targets: [RestockTarget!]!) {
  restock(targets: $targets) {
    typeName
    groupName
    target
    onHand
    delta
    toBuy
  }
}`,
    variables: {
      targets: [
        { type: 'Nitrogen Fuel Block', quantity: 10000 },
        { type: 'Tritanium', quantity: 1000000 },
      ],
    },
  },
]
