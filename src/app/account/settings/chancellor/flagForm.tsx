'use client'

import { useState } from 'react'
import { union, without } from 'ramda'

import { KNOWN_FLAGS } from '@/flagCatalog'

import Dot from '../dot'
import { AccountFlags, lookupAccountFlags, setAccountFlags } from './actions'

// Set another account's dark-launch flags. Two steps: look an account up by one
// of its character names (which loads its current flags), then tick the boxes
// and save. The saved list is whatever is ticked, so unticking removes a flag.
const FlagForm = () => {
  const [account, setAccount] = useState<AccountFlags | null>(null)
  const [flags, setFlags] = useState<string[]>([])
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const say = (message: string, ok: boolean) => {
    setColor(ok ? '#00AF00' : '#FF0000')
    setResponse(message)
  }

  const lookup = async (formData: FormData) => {
    const result = await lookupAccountFlags(formData)
    if ('error' in result) {
      setAccount(null)
      say(result.error, false)
      return
    }
    setAccount(result)
    setFlags(result.flags)
    say(result.flags.length ? `${result.name}: ${result.flags.join(', ')}` : `${result.name} has no flags set.`, true)
  }

  const save = async () => {
    if (!account) return
    const result = await setAccountFlags(account.userId, flags)
    if (result.error) {
      say(result.error, false)
      return
    }
    setAccount({ ...account, flags })
    say(result.ok ?? 'Done', true)
  }

  const toggle = (flag: string, on: boolean) => setFlags(on ? union(flags, [flag]) : without([flag], flags))

  // Flags the account already carries but this build doesn't know about (set by
  // hand, or left over from a retired flag) still get a box, so saving can't
  // silently drop them.
  const names = union(
    KNOWN_FLAGS.map((f) => f.flag),
    account?.flags ?? []
  )
  const labelFor = (flag: string) => KNOWN_FLAGS.find((f) => f.flag === flag)?.label ?? 'unrecognized flag'

  return (
    <>
      <form>
        <label htmlFor="flag-name">Character name: </label>
        <input id="flag-name" name="name" type="text" required /> <button formAction={lookup}>Load flags</button>
      </form>

      {account && (
        <form>
          {/* The account's own id, shown because the Impersonate form below
              takes a user id and this lookup is the only place to get one. */}
          <p>
            User ID: <code>{account.userId}</code>
          </p>
          <ul>
            {names.map((flag) => (
              <li key={flag}>
                <label>
                  <input
                    type="checkbox"
                    checked={flags.includes(flag)}
                    onChange={(e) => toggle(flag, e.target.checked)}
                  />{' '}
                  <code>{flag}</code> — {labelFor(flag)}
                </label>
              </li>
            ))}
          </ul>
          <button formAction={save}>Save flags for {account.name}</button>
        </form>
      )}

      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default FlagForm
