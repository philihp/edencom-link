'use client'

import { useState } from 'react'

import Dot from '../../account/settings/dot'
import { saveTaxRates } from './actions'
import { TaxRates, toPercent } from './rates'
import styles from './tax.module.css'

// Percents in the boxes, fractions in the column. Stringified through
// toPercent so 0.001 shows as 0.1 rather than 0.1 with float noise on it.
const TaxForm = ({ rates }: { rates: TaxRates }) => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const save = async (formData: FormData) => {
    const result = await saveTaxRates(formData)
    setColor(result.error ? '#FF0000' : '#00AF00')
    setResponse(result.error ?? result.ok ?? '')
  }

  return (
    <form action={save}>
      <ul className={styles.list}>
        <li className={styles.item}>
          <label className={styles.row} htmlFor="tax-own">
            <span className={styles.name}>Tax rate that your alts pay</span>
            <span className={styles.field}>
              <input
                id="tax-own"
                name="own"
                type="number"
                min="0"
                max="100"
                step="0.001"
                defaultValue={toPercent(rates.own)}
                required
              />
              <span className={styles.unit}>%</span>
            </span>
          </label>
          <p className={styles.why}>
            What your own characters are charged to install a job in a structure your corporations own — the members
            rate you set on the structure itself.
          </p>
        </li>
        <li className={styles.item}>
          <label className={styles.row} htmlFor="tax-public">
            <span className={styles.name}>Public tax rate</span>
            <span className={styles.field}>
              <input
                id="tax-public"
                name="public"
                type="number"
                min="0"
                max="100"
                step="0.001"
                defaultValue={toPercent(rates.public)}
                required
              />
              <span className={styles.unit}>%</span>
            </span>
          </label>
          <p className={styles.why}>
            What the same job would have cost you in somebody else&rsquo;s public structure. The difference between the
            two rates is the cost avoidance reported on Structures.
          </p>
        </li>
      </ul>

      <button type="submit">Save rates</button>

      <p>{response && <Dot color={color} response={response} />}</p>
    </form>
  )
}

export default TaxForm
