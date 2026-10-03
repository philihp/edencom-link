import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { addIndex, map } from 'ramda'

import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Terms of Service — Edencom Link',
}

const REPO = 'https://github.com/philihp/edencom-link'

type Section = { id: string; title: string; body: ReactNode }

const SECTIONS: Section[] = [
  {
    id: 'acceptance',
    title: 'Acceptance of Terms',
    body: (
      <>
        <p>
          Edencom Link (&ldquo;Link&rdquo;, &ldquo;we&rdquo;) is the website at edencom.link, its API, and the fittings
          desktop client. When you use any of them, you accept these terms and our <a href="/privacy">Privacy Policy</a>
          . If you do not agree, do not use Link.
        </p>
        <p>
          These terms and the Privacy Policy are the whole agreement between you and Link about your use of the service.
          They replace any earlier agreement.
        </p>
      </>
    ),
  },
  {
    id: 'eligibility',
    title: 'Eligibility',
    body: (
      <>
        <p>
          You must be at least 13 years old to use Link. This is the same age EVE Online requires. When you use Link,
          you confirm that you meet this requirement.
        </p>
        <p>If you are under 18, you confirm that a parent or guardian has read and agreed to these terms for you.</p>
      </>
    ),
  },
  {
    id: 'service',
    title: 'Service Description',
    body: (
      <>
        <p>
          Link is a fan-made tool for EVE Online players. It is a personal, non-commercial hobby project, provided free
          of charge. With the EVE characters you link, it:
        </p>
        <ul>
          <li>
            Reads the game data you authorize through EVE&rsquo;s ESI API &mdash; assets, wallet, market orders,
            industry jobs, blueprints, clones, skills, location, ship, saved fittings, contracts and mercenary dens, and
            corporation structures, assets, jobs and wallet where you hold the in-game roles &mdash; and keeps a history
            of it over time.
          </li>
          <li>
            Shows that data back to you: hangars, wallets, industry, structures, blueprints, cost indices, market prices
            and a ship fitting viewer.
          </li>
          <li>
            Lets you share parts of it with your corporation, your alliance or the public, by share links, Data Links,
            spreadsheet exports and a Model Context Protocol (MCP) server.
          </li>
          <li>Keeps an archive of saved fittings, with a desktop client that mounts it as files.</li>
          <li>Estimates values and costs, and can send alerts to a Discord channel you connect.</li>
        </ul>
        <p>
          These tools support play in EVE Online, a massively multiplayer online game. Every reference to
          &ldquo;ISK&rdquo;, &ldquo;assets&rdquo;, &ldquo;contracts&rdquo; and similar terms means virtual items and
          currency inside the game. They have no real-world monetary value and cannot be exchanged for real currency.
        </p>
        <p>
          All content and data, including static game data, market prices, appraisals and cost estimates, is provided
          &ldquo;as is&rdquo; without warranty. We make no claim that it is accurate, complete or fit for any purpose.
        </p>
      </>
    ),
  },
  {
    id: 'account',
    title: 'Your Account and Linked Characters',
    body: (
      <>
        <p>You are responsible for your account and for the EVE characters you link to it. You agree to:</p>
        <ul>
          <li>Link only characters you control.</li>
          <li>Keep your password, your API token and your share links private.</li>
          <li>Keep your EVE Online credentials and your own computer secure.</li>
          <li>Treat everything done with your account or your tokens as done by you.</li>
        </ul>
        <p>
          You can revoke Link&rsquo;s access to a character at any time in your EVE Online account&rsquo;s third-party
          application settings. After that, Link can no longer read new data for that character.
        </p>
      </>
    ),
  },
  {
    id: 'conduct',
    title: 'User Conduct',
    body: (
      <>
        <p>You agree to:</p>
        <ul>
          <li>Use Link in compliance with all applicable laws.</li>
          <li>Not try to read, change or delete data that belongs to another account.</li>
          <li>Not try to disrupt, compromise or reverse engineer the service.</li>
          <li>Not use Link for any unlawful purpose, or to break CCP&rsquo;s or Discord&rsquo;s terms.</li>
          <li>Not try to get unauthorized access to any part of the service.</li>
          <li>
            Not use automated systems to access the website outside the API we provide, and not use the API at a rate
            that degrades the service for others.
          </li>
          <li>Not misrepresent your identity or your affiliation.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'virtual-items',
    title: 'Virtual Items and Currency',
    body: (
      <>
        <p>
          Link reads and estimates the value of virtual items and currency (&ldquo;ISK&rdquo;) in EVE Online. You
          acknowledge and agree that:
        </p>
        <ul>
          <li>Virtual items and ISK have no real-world monetary value.</li>
          <li>Link does not exchange virtual items or ISK for real currency, and does not trade them at all.</li>
          <li>
            Every valuation, appraisal, price, cost index, tax estimate and shipping quote Link shows is an estimate for
            in-game reference only.
          </li>
          <li>Link is not responsible for any loss, theft or destruction of virtual items or ISK.</li>
          <li>Transactions involving virtual items are governed by CCP Games&rsquo; Terms of Service.</li>
        </ul>
        <p>
          We disclaim all liability related to virtual items, including their estimated values, loss during
          transactions, and any dispute that comes from in-game activities.
        </p>
      </>
    ),
  },
  {
    id: 'sharing',
    title: 'Sharing and Data Links',
    body: (
      <>
        <p>
          Nothing you link is shared until you share it. Link lets you share a ship, a fitting, your blueprint
          originals, your mercenary dens or a saved query with your corporation, your alliance, specific people or the
          public. The following terms apply:
        </p>
        <ul>
          <li>You decide what to share and with whom. Review a share before you create it.</li>
          <li>
            A share link works for anyone who holds it. If you send a link to one person, that person can send it to
            others. Keep links private, and remove a share when you no longer want it.
          </li>
          <li>
            A corporation or alliance share goes to the members of that organization as Link knows them. Membership data
            comes from CCP and can lag behind the game.
          </li>
          <li>
            A Data Link runs a query you wrote, under your account, for whoever opens it. You are responsible for what
            the query exposes.
          </li>
          <li>Recipients can copy what you share. Link cannot take back data a recipient has already seen or saved.</li>
          <li>We may remove a share, or turn sharing off, at any time without notice.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'fittings',
    title: 'Fittings Archive and Desktop Client',
    body: (
      <>
        <p>
          Link can keep an archive of your saved fittings, and a desktop client can mount your in-game fitting list as
          files. These additional terms apply:
        </p>
        <ul>
          <li>
            The desktop client is open source and provided free of charge, in the <a href={REPO}>Link repository</a>.
          </li>
          <li>
            This is the one place where Link writes to your EVE account. Deleting a fitting file deletes that fitting in
            the game. You turn this on yourself, by granting the write scope when you link the character.
          </li>
          <li>
            Link records a copy of each fitting before it changes or deletes it in the game. We try to make a restore
            possible, but we do not guarantee it.
          </li>
          <li>You are responsible for the security of your own computer and your EVE Online credentials.</li>
          <li>We are not responsible for any lost fitting, in-game asset or ISK.</li>
        </ul>
        <p>
          The fittings archive and the desktop client are provided &ldquo;as is&rdquo; without warranty of any kind,
          express or implied. Use them entirely at your own risk.
        </p>
      </>
    ),
  },
  {
    id: 'api',
    title: 'API Access',
    body: (
      <>
        <p>
          Link exposes your data through an MCP server, Data Links, CSV exports for spreadsheets and the fittings API.
          The following terms apply:
        </p>
        <ul>
          <li>
            An API token, an OAuth grant or a Data Link gives the holder the same access to your data that you have
            through it. Treat each one as a credential.
          </li>
          <li>
            Any tool you connect to the API, including an AI assistant, acts as you. You are responsible for what it
            does with your account.
          </li>
          <li>
            The API has no guaranteed availability, rate limit or compatibility. We may change or remove it at any time.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'warranties',
    title: 'Disclaimer of Warranties',
    body: (
      <>
        <p>
          LINK IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, WHETHER
          EXPRESS, IMPLIED, STATUTORY OR OTHERWISE. THIS INCLUDES, WITHOUT LIMITATION, IMPLIED WARRANTIES OF
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT.
        </p>
        <p>
          We do not warrant that: (a) the service will be uninterrupted, timely, secure or error-free; (b) any
          information provided is accurate, complete, reliable or current; (c) any defect will be corrected; (d) data
          stored by the service will be kept or will not be lost; or (e) the service is free of viruses or other harmful
          components.
        </p>
        <p>
          The service may be unavailable, lose data or show incorrect information at any time. Any reliance on
          information provided through the service is strictly at your own risk.
        </p>
      </>
    ),
  },
  {
    id: 'liability',
    title: 'Limitation of Liability',
    body: (
      <>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, LINK AND ITS OPERATOR SHALL NOT BE LIABLE FOR ANY INDIRECT,
          INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE OR EXEMPLARY DAMAGES, INCLUDING BUT NOT LIMITED TO DAMAGES FOR
          LOSS OF PROFITS, GOODWILL, USE, DATA, VIRTUAL ITEMS OR OTHER INTANGIBLE LOSSES, REGARDLESS OF WHETHER WE HAVE
          BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
        </p>
        <p>
          IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS EXCEED THE AMOUNT YOU PAID US (IF ANY) IN THE
          TWELVE (12) MONTHS PRECEDING THE CLAIM, OR ONE HUNDRED US DOLLARS ($100), WHICHEVER IS LESS.
        </p>
        <p>
          This limitation applies to all claims, whether based on warranty, contract, tort or any other legal theory,
          and whether or not we have been informed of the possibility of such damage.
        </p>
      </>
    ),
  },
  {
    id: 'indemnification',
    title: 'Indemnification',
    body: (
      <p>
        You agree to defend, indemnify and hold harmless Link and its operator from and against any claims, damages,
        obligations, losses, liabilities, costs or expenses (including reasonable attorneys&rsquo; fees) arising from:
        (a) your use of the service; (b) your violation of these terms; (c) your violation of any third-party rights,
        including CCP Games&rsquo; Terms of Service; or (d) any content you share, submit or transmit through the
        service.
      </p>
    ),
  },
  {
    id: 'disputes',
    title: 'Dispute Resolution',
    body: (
      <>
        <p>
          <strong>Informal resolution.</strong> Before you start any formal dispute proceeding, contact us (see{' '}
          <a href="#contact">Contact</a>) so we can try to resolve the dispute informally.
        </p>
        <p>
          <strong>Class action waiver.</strong> TO THE EXTENT PERMITTED BY LAW, YOU AGREE THAT ANY DISPUTE WILL BE
          RESOLVED ON AN INDIVIDUAL BASIS AND NOT AS PART OF ANY CLASS, CONSOLIDATED OR REPRESENTATIVE ACTION.
        </p>
        <p>
          <strong>Time limitation.</strong> Any claim or cause of action arising from or related to use of the service
          must be filed within one (1) year after the claim arose, or be forever barred.
        </p>
      </>
    ),
  },
  {
    id: 'governing-law',
    title: 'Governing Law and Jurisdiction',
    body: (
      <>
        <p>
          These terms are governed by and construed in accordance with the laws of the Province of Ontario and the
          federal laws of Canada applicable therein, without regard to conflict of law principles.
        </p>
        <p>
          Any dispute arising from these terms or from use of the service is subject to the exclusive jurisdiction of
          the courts of the Province of Ontario, Canada.
        </p>
        <p>
          If you are a consumer in the European Union, you keep any mandatory consumer protection rights under the laws
          of your country of residence.
        </p>
      </>
    ),
  },
  {
    id: 'eve-online',
    title: 'EVE Online and CCP Games',
    body: (
      <>
        <p>
          Link is an independent fan project. It is not affiliated with, endorsed by or connected to CCP hf. We use EVE
          Online&rsquo;s ESI API and CCP&rsquo;s Static Data Export under CCP&rsquo;s Developer License Agreement.
        </p>
        <p>
          EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights are reserved worldwide. All
          other trademarks are the property of their respective owners. EVE Online, the EVE logo, EVE and all associated
          logos and designs are the intellectual property of CCP hf. All artwork, screenshots, characters, vehicles,
          storylines, world facts, or other recognizable features of the intellectual property relating to these
          trademarks are likewise the intellectual property of CCP hf.
        </p>
      </>
    ),
  },
  {
    id: 'discord',
    title: 'Discord',
    body: (
      <>
        <p>
          You can sign in to Link with a Discord account, and you can connect a Discord channel to receive alerts. When
          you use these features you agree that:
        </p>
        <ul>
          <li>Discord&rsquo;s Terms of Service and Community Guidelines apply to your use of Discord.</li>
          <li>You connect a channel only on a server where you have the authority to do so.</li>
          <li>
            Alerts posted to a channel are visible to everyone in that channel, and are governed by Discord&rsquo;s
            terms, not ours.
          </li>
          <li>We may stop sending alerts to a channel at any time.</li>
        </ul>
        <p>
          Discord is a third-party platform. We provide no warranty about Discord&rsquo;s availability, security or
          functionality. Discord is a trademark of Discord Inc. Link is not affiliated with or endorsed by Discord Inc.
        </p>
      </>
    ),
  },
  {
    id: 'third-parties',
    title: 'External Links and Third-party Services',
    body: (
      <>
        <p>Link links to, and gets data from, third-party websites and services that we do not own or control:</p>
        <ul>
          <li>CCP Games and EVE Online, the source of all game data.</li>
          <li>Supabase and Vercel, which store the data and host the site.</li>
          <li>Discord, for sign-in and alerts.</li>
          <li>
            innomin.at for appraisals, appraise.gnf.lt for market prices and KumGo for shipping quotes. An appraisal or
            quote sends only item names and quantities, or route and cargo figures, to that service.
          </li>
          <li>GitHub, where the source code and the issue tracker live.</li>
        </ul>
        <p>
          We have no control over, and take no responsibility for, the content, privacy policies, practices or
          availability of any third-party website or service. A link to an external site is not an endorsement.
        </p>
        <p>
          You agree that Link is not responsible or liable, directly or indirectly, for any damage or loss caused or
          alleged to be caused by use of or reliance on any content, goods or services available through a third-party
          website or service. Read the terms and privacy policies of any third-party service you use.
        </p>
      </>
    ),
  },
  {
    id: 'termination',
    title: 'Termination',
    body: (
      <>
        <p>
          We may suspend or end your access to the service at any time, for any reason, without notice. We may also
          change or discontinue the service itself at any time.
        </p>
        <p>
          You can end this agreement at any time by asking us to delete your account (see the{' '}
          <a href="/privacy">Privacy Policy</a>).
        </p>
        <p>
          After termination, every provision of these terms that by its nature should survive stays in effect, including
          the warranty disclaimer, the limitation of liability and the indemnification.
        </p>
      </>
    ),
  },
  {
    id: 'modifications',
    title: 'Modifications',
    body: (
      <p>
        We may change these terms at any time. A material change is shown by the date at the top of this page. If you
        continue to use the service after a change, you accept the changed terms.
      </p>
    ),
  },
  {
    id: 'severability',
    title: 'Severability',
    body: (
      <p>
        If a court of competent jurisdiction finds a provision of these terms unenforceable or invalid, that provision
        is limited or removed to the minimum extent necessary. The remaining provisions stay in full force and effect.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <p>
        For questions about these terms, open an issue on the project&rsquo;s <a href={REPO}>GitHub repository</a>.
      </p>
    ),
  },
]

const mapIndexed = addIndex<Section, ReactNode>(map)

const numbered = (title: string, index: number) => `${index + 1}. ${title}`

const TermsPage = () => (
  <main className={styles.wrap}>
    <h1>Terms of Service</h1>
    <p className={styles.updated}>Last updated: 3 October 2026</p>

    <p>Usage agreement for Edencom Link.</p>

    <h2>Contents</h2>
    <ol className={styles.contents}>
      {map(
        ({ id, title }) => (
          <li key={id}>
            <a href={`#${id}`}>{title}</a>
          </li>
        ),
        SECTIONS
      )}
    </ol>

    {mapIndexed(
      ({ id, title, body }, index) => (
        <section key={id} id={id}>
          <h2>{numbered(title, index)}</h2>
          {body}
        </section>
      ),
      SECTIONS
    )}
  </main>
)

export default TermsPage
