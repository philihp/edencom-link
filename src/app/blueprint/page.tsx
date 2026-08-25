import Link from 'next/link'

import { resolveLibraries, type Library } from './libraries'
import { SharedSearchBox } from './sharedSearchBox'
import { TypeSearch } from './typeSearch'

const List = ({ heading, libraries }: { heading: string; libraries: Library[] }) => (
  <>
    <h2>{heading}</h2>
    <ul>
      {libraries.map((library) => (
        <li key={library.key}>
          <Link href={library.href}>{library.label}</Link> — {library.note}
        </li>
      ))}
    </ul>
  </>
)

// The blueprint libraries this account can open, in two lists (see
// ./libraries), with a search across the shared ones sitting between them: the
// list answers "whose libraries can I open", and the box answers "which of them
// has the thing I want".
const BposLibraries = async () => {
  const { mine, shared } = await resolveLibraries()
  if (mine.length === 0 && shared.length === 0) return null

  return (
    <>
      {mine.length > 0 && <List heading="Your blueprint libraries" libraries={mine} />}
      {shared.length > 0 && (
        <>
          <h2>Search shared libraries</h2>
          <SharedSearchBox />
          <List heading="Shared with you" libraries={shared} />
        </>
      )}
    </>
  )
}

const BlueprintPage = () => (
  <>
    <h1>Blueprint</h1>
    <p>Given a blueprint, this tool will tell you which Upwell rigs give it a bonus.</p>
    <TypeSearch />
    <BposLibraries />
  </>
)

export default BlueprintPage
