'use server'

import { searchBlueprints } from './api'

export const searchType = async (typeNameSubstring: string): Promise<[string, string][]> =>
  searchBlueprints(typeNameSubstring)
