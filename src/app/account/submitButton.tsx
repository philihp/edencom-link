'use client'

import { useFormStatus } from 'react-dom'

import styles from './auth.module.css'

// The submit control for the sign-on forms. `useFormStatus` reports the pending
// state of the enclosing form's own action, so the label flips while the server
// action is in flight without each form tracking a second piece of state. The
// sign-on actions deliberately take a beat (login sleeps 1s, register 5s) —
// long enough that a static label reads as a dead button.
//
// `disabled` is for the caller's own gating (register keeps the button off after
// a successful sign-up until a field changes); pending is OR'd in on top.
const SubmitButton = ({
  children,
  pendingLabel,
  disabled,
  formAction,
}: {
  children: React.ReactNode
  pendingLabel: string
  disabled?: boolean
  formAction: (formData: FormData) => void | Promise<void>
}) => {
  const { pending } = useFormStatus()

  return (
    <button className={styles.submit} formAction={formAction} disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </button>
  )
}

export default SubmitButton
