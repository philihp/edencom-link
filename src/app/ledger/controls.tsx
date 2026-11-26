'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { MONTH_WINDOW_OPTIONS } from '../../ledger/statement'
import styles from '../windowSelect.module.css'

// The two controls of /ledger: the wallet (the group, or one wallet) and the
// trailing months. Both live in the URL (`?wallet=`, `?months=`), because the
// server component asks the statement for exactly that scope and window. The
// days dropdown of timeWindow.ts does not fit here: the statement is by UTC
// month, so the window is whole months.

export type WalletOption = { key: string; label: string }

type Props = { months: number; wallet: string | null; wallets: readonly WalletOption[] }

const href = (months: number, wallet: string | null): string =>
  `/ledger?months=${months}${wallet === null ? '' : `&wallet=${encodeURIComponent(wallet)}`}`

const GROUP = ''

export const LedgerControls = ({ months, wallet, wallets }: Props) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const go = (nextMonths: number, nextWallet: string | null) =>
    startTransition(() => router.replace(href(nextMonths, nextWallet), { scroll: false }))
  return (
    <p>
      <label className={styles.windowSelect} data-pending={pending || undefined}>
        <span className={styles.srOnly}>Wallet</span>
        <select value={wallet ?? GROUP} onChange={(e) => go(months, e.target.value === GROUP ? null : e.target.value)}>
          <option value={GROUP}>The group, internal transfers left out</option>
          {wallets.map((w) => (
            <option key={w.key} value={w.key}>
              {w.label}
            </option>
          ))}
        </select>
      </label>{' '}
      <label className={styles.windowSelect} data-pending={pending || undefined}>
        <span className={styles.srOnly}>Time window</span>
        <select value={months} onChange={(e) => go(Number(e.target.value), wallet)}>
          {MONTH_WINDOW_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 1 ? 'this month' : `${n} months`}
            </option>
          ))}
        </select>
      </label>
    </p>
  )
}
