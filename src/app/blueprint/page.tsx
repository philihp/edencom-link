import { createClient } from '@/utils/supabase/server'
import { TypeSearch } from './typeSearch'

const BlueprintPage = async () => {
  const supabase = await createClient()
  await supabase.schema('evesde').from('invTypes').select('*').limit(100).select()
  return (
    <>
      <h1>Blueprint</h1>
      <p>Given a blueprint, this tool will tell you which Upwell rigs will give it a bonus</p>
      <form>
        <TypeSearch />
      </form>
    </>
  )
}

export default BlueprintPage
