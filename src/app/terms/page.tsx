import type { Metadata } from 'next'

import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Terms of Service — Edencom Link',
}

const TermsPage = () => (
  <main className={styles.wrap}>
    <h1>Terms of Service</h1>
    <p className={styles.updated}>Last updated: 19 July 2026</p>

    <p>Edencom Link is a personal, non-commercial hobby project, provided free of charge and &ldquo;as is.&rdquo;</p>

    <ul>
      <li>
        <strong>No warranty.</strong> The site is provided without warranty of any kind. It may be unavailable, lose
        data, or show incorrect information at any time. Do not rely on it for anything critical.
      </li>
      <li>
        <strong>Your responsibility.</strong> You are responsible for the EVE characters and accounts you link and for
        keeping your credentials and share links private. Only link characters you control.
      </li>
      <li>
        <strong>Acceptable use.</strong> Do not attempt to access data belonging to accounts other than your own,
        disrupt the service, or use it to violate CCP&rsquo;s or Discord&rsquo;s terms.
      </li>
      <li>
        <strong>Changes.</strong> These terms and the service itself may change or be discontinued at any time.
      </li>
    </ul>

    <h2>EVE Online</h2>
    <p>
      EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights are reserved worldwide. All other
      trademarks are the property of their respective owners. EVE Online, the EVE logo, EVE and all associated logos and
      designs are the intellectual property of CCP hf. All artwork, screenshots, characters, vehicles, storylines, world
      facts, or other recognizable features of the intellectual property relating to these trademarks are likewise the
      intellectual property of CCP hf. This site is not affiliated with or endorsed by CCP hf.
    </p>

    <h2>Discord</h2>
    <p>Discord is a trademark of Discord Inc. This site is not affiliated with or endorsed by Discord Inc.</p>
  </main>
)

export default TermsPage
