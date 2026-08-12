import type { MessageSpec } from './protobuf'

// The six messages of src/esf.proto, as data for ./protobuf.ts. Field numbers
// and names must track that file exactly — it's the schema src/buildEsfData.js
// encodes with, and the field *names* are the contract with the WASM engine
// (it reads `groupID`, `attributeID`, `modifierInfo`, … off these objects by
// name). Keep the declarations in the same order as the .proto so the two can
// be diffed side by side.
//
// `defaults` holds only what proto2 gives a value to when it's missing: the
// zero of each *required* field. Optional fields are deliberately absent —
// they must read back `undefined`, not a zero. Repeated fields need no entry:
// the decoder always materializes them as an (own) array.

const typeDogmaAttribute: MessageSpec = {
  fields: {
    1: { name: 'attributeID', kind: 'int32' },
    2: { name: 'value', kind: 'float' },
  },
  defaults: { attributeID: 0, value: 0 },
}

const typeDogmaEffect: MessageSpec = {
  fields: {
    1: { name: 'effectID', kind: 'int32' },
    2: { name: 'isDefault', kind: 'bool' },
  },
  defaults: { effectID: 0, isDefault: false },
}

export const typeDogmaEntry: MessageSpec = {
  fields: {
    1: { name: 'dogmaAttributes', kind: 'message', of: typeDogmaAttribute, repeated: true },
    2: { name: 'dogmaEffects', kind: 'message', of: typeDogmaEffect, repeated: true },
  },
  defaults: {},
}

export const type: MessageSpec = {
  fields: {
    1: { name: 'name', kind: 'string' },
    2: { name: 'groupID', kind: 'int32' },
    3: { name: 'categoryID', kind: 'int32' },
    4: { name: 'published', kind: 'bool' },
    5: { name: 'factionID', kind: 'int32' },
    6: { name: 'marketGroupID', kind: 'int32' },
    7: { name: 'metaGroupID', kind: 'int32' },
    8: { name: 'capacity', kind: 'float' },
    9: { name: 'mass', kind: 'float' },
    10: { name: 'radius', kind: 'float' },
    11: { name: 'volume', kind: 'float' },
  },
  defaults: { name: '', groupID: 0, categoryID: 0, published: false },
}

export const group: MessageSpec = {
  fields: {
    1: { name: 'name', kind: 'string' },
    2: { name: 'categoryID', kind: 'int32' },
    3: { name: 'published', kind: 'bool' },
  },
  defaults: { name: '', categoryID: 0, published: false },
}

export const marketGroup: MessageSpec = {
  fields: {
    1: { name: 'name', kind: 'string' },
    2: { name: 'parentGroupID', kind: 'int32' },
    3: { name: 'iconID', kind: 'int32' },
  },
  defaults: { name: '' },
}

export const dogmaAttribute: MessageSpec = {
  fields: {
    1: { name: 'name', kind: 'string' },
    2: { name: 'published', kind: 'bool' },
    3: { name: 'defaultValue', kind: 'float' },
    4: { name: 'highIsGood', kind: 'bool' },
    5: { name: 'stackable', kind: 'bool' },
  },
  defaults: { name: '', published: false, defaultValue: 0, highIsGood: false, stackable: false },
}

// Domain and Func are proto enums, i.e. varints on the wire; the engine reads
// them as the numbers the generated decoder also produces.
const modifierInfo: MessageSpec = {
  fields: {
    1: { name: 'domain', kind: 'int32' },
    2: { name: 'func', kind: 'int32' },
    3: { name: 'modifiedAttributeID', kind: 'int32' },
    4: { name: 'modifyingAttributeID', kind: 'int32' },
    5: { name: 'operation', kind: 'int32' },
    6: { name: 'groupID', kind: 'int32' },
    7: { name: 'skillTypeID', kind: 'int32' },
  },
  defaults: { domain: 0, func: 0 },
}

export const dogmaEffect: MessageSpec = {
  fields: {
    1: { name: 'name', kind: 'string' },
    2: { name: 'effectCategory', kind: 'int32' },
    3: { name: 'electronicChance', kind: 'bool' },
    4: { name: 'isAssistance', kind: 'bool' },
    5: { name: 'isOffensive', kind: 'bool' },
    6: { name: 'isWarpSafe', kind: 'bool' },
    7: { name: 'propulsionChance', kind: 'bool' },
    8: { name: 'rangeChance', kind: 'bool' },
    9: { name: 'dischargeAttributeID', kind: 'int32' },
    10: { name: 'durationAttributeID', kind: 'int32' },
    11: { name: 'rangeAttributeID', kind: 'int32' },
    12: { name: 'falloffAttributeID', kind: 'int32' },
    13: { name: 'trackingSpeedAttributeID', kind: 'int32' },
    14: { name: 'fittingUsageChanceAttributeID', kind: 'int32' },
    15: { name: 'resistanceAttributeID', kind: 'int32' },
    16: { name: 'modifierInfo', kind: 'message', of: modifierInfo, repeated: true },
  },
  defaults: {
    name: '',
    effectCategory: 0,
    electronicChance: false,
    isAssistance: false,
    isOffensive: false,
    isWarpSafe: false,
    propulsionChance: false,
    rangeChance: false,
  },
}
