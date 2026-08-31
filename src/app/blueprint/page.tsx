import Link from 'next/link'

import { resolveLibraries, type Library } from './libraries'
import { SharedSearchBox } from './sharedSearchBox'
import { TypeSearch } from './typeSearch'

// A corporation's library reaches us because a PERSON published it, and the
// label names the corporation rather than them — so say who, the same way the
// shared-library search does. An account's library needs no such line: the
// label is already its owner's main. A row whose publisher has since deleted
// their account (created_by nulls out) simply goes without.
const sharedByNote = (library: Library) =>
  library.subject.kind === 'corporation' && library.sharedBy ? `, shared by ${library.sharedBy}` : ''

const List = ({ heading, libraries }: { heading: string; libraries: Library[] }) => (
  <>
    <h2>{heading}</h2>
    <ul>
      {libraries.map((library) => (
        <li key={library.key}>
          <Link href={library.href}>{library.label}</Link> — {library.note}
          {sharedByNote(library)}
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
