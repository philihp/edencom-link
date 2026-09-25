'use client'

import { useState } from 'react'

import Dot from '../../dot'
import { saveHullPrice } from './actions'

// One hull's price field, in billions of ISK. An empty field clears the price.
const HullPriceForm = ({ typeId, price }: { typeId: number; price: string }) => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const submit = async (formData: FormData) => {
    const result = await saveHullPrice(formData)
    setColor(result.error ? '#FF0000' : '#00AF00')
    setResponse(result.error ?? result.ok ?? 'Saved')
  }

  return (
    <form>
      <input type="hidden" name="type_id" value={typeId} />
      <input
        name="price"
        type="text"
        inputMode="decimal"
        defaultValue={price}
        size={8}
        aria-label="Price in bISK"
      />{' '}
      bISK <button formAction={submit}>Save</button> {response && <Dot color={color} response={response} />}
    </form>
  )
}

export default HullPriceForm
