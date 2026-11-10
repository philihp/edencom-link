'use client'

import { type IconVariation } from '../../iconVariation'
import { TypeIcon } from '../../typeIcon'
import styles from './iconCheckbox.module.css'

type IconCheckboxProps = {
  typeId: number
  prefer: IconVariation
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

// A row's selection checkbox that wears the item's icon while it is at rest.
// Under the pointer (or keyboard focus) the icon fades out to an empty box in
// 200ms; a tick draws itself when the box is checked and stays while it is; an
// unchecked box fades back to the icon in 300ms when the pointer leaves. All of
// it is CSS on a real <input>, so the keyboard, a screen reader and the marquee
// (which sets `checked` from state) all drive the same picture.
//
// The input lies invisible over the face rather than hidden away, so the click
// lands on the control itself and focus has somewhere to be.
export const IconCheckbox = ({ typeId, prefer, checked, onChange, label }: IconCheckboxProps) => (
  <label className={styles.slop}>
    <span className={styles.face}>
      <input
        type="checkbox"
        className={styles.input}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <TypeIcon id={typeId} prefer={prefer} className={styles.icon} />
      <svg className={styles.box} viewBox="0 0 24 24" aria-hidden="true">
        <rect className={styles.frame} x="4" y="4" width="16" height="16" rx="3" />
        {/* pathLength 1 lets the stroke dash run 0→1 whatever the real length. */}
        <path className={styles.tick} d="M7.5 12.5 L10.5 15.5 L16.5 8.5" pathLength={1} />
      </svg>
    </span>
  </label>
)
