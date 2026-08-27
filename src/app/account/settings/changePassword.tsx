'use client'

import { useState } from 'react'

import { changePassword } from './actions'
import Dot from './dot'
import styles from './settings.module.css'

// The password row's editor: a readout by default ("editing is an action you
// take"), the two-field form one disclosure away.
const ChangePassword = () => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('var(--ink)')

  const changePasswordAndReturn = async (formData: FormData) => {
    const error = await changePassword(formData)
    if (error) {
      setResponse(error)
      setColor('var(--danger)')
      return
    }

    setColor('var(--ok)')
    setResponse('Password changed')
  }

  return (
    <details className={styles.disclosure}>
      <summary>change</summary>
      <form className={styles.disclosureBody}>
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" required />
        <label htmlFor="confirm">Confirm password</label>
        <input id="confirm" name="confirm" type="password" required />
        <button formAction={changePasswordAndReturn}>Change password</button>
        {response && <Dot color={color} response={response} />}
      </form>
    </details>
  )
}

export default ChangePassword
