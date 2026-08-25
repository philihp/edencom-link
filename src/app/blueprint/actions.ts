'use server'

import { searchBlueprints } from './api'
import { type SharedSearchResult } from './searchHits'
import { searchSharedBlueprints } from './sharedSearch'

export const searchType = async (typeNameSubstring: string): Promise<[string, string][]> =>
  searchBlueprints(typeNameSubstring)

// The shared-library search. Everything it may read is decided server-side from
// the caller's own session, so the substring is the only input.
export const searchShared = async (substring: string): Promise<SharedSearchResult> => searchSharedBlueprints(substring)
