'use server'

import { createClient } from '@/utils/supabase/server'

export const searchType = async (typeNameSubstring: string): Promise<[string, string][]> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .schema('evesde')
    .from('invTypes')
    .select()
    .textSearch('typeName', `'${typeNameSubstring}' & 'Blueprint'`)
    .limit(6)
  if (error) {
    console.error(error)
    return []
  }
  return data.map((row) => {
    return [`${row?.typeID}`, `${row?.typeName}`]
  })
}
