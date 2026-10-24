import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { map } from 'ramda'

import legal from '../legal.module.css'
import styles from './page.module.css'

export const metadata: Metadata = {
  title: 'Aura MCP — Edencom Link',
  description:
    'Connect Aura, Claude, ChatGPT or any other MCP-capable companion to your EVE Online data on Edencom Link.',
}

const SERVER_URL = 'https://edencom.link/api/mcp'
const REPO = 'https://github.com/philihp/edencom-link'

type Section = { id: string; title: string; body: ReactNode }

// What a client sees once connected — grouped the way the tools are registered
// (src/app/api/mcp/*Tools.ts). Keep in step with the server; the list is
// cosmetic, the server is what the companion actually calls.
const TOOL_GROUPS: { title: string; tools: string[] }[] = [
  {
    title: 'Hangars and wallets',
    tools: ['search_assets', 'list_assets', 'browse_assets', 'appraise_assets', 'appraise_items', 'wallet_summary'],
  },
  {
    title: 'Industry',
    tools: [
      'list_blueprints',
      'list_industry_jobs',
      'list_job_slots',
      'industry_cost_indices',
      'blueprint_for_product',
      'blueprints_using_material',
      'rigs_for_blueprint',
      'module_variants',
    ],
  },
  {
    title: 'Markets and contracts',
    tools: ['list_market_orders', 'search_transactions', 'search_public_contracts', 'shipping_quote'],
  },
  {
    title: 'Everything else you linked',
    tools: ['list_structures', 'list_clones', 'list_fittings', 'list_mercenary_dens', 'list_planets'],
  },
  {
    title: 'EVE mail',
    tools: ['list_mail', 'read_mail', 'send_mail'],
  },
  {
    title: 'Queries and Data Links',
    tools: ['link_schema', 'run_query', 'list_links', 'create_link', 'update_link', 'edit_watched_systems'],
  },
]

const SECTIONS: Section[] = [
  {
    id: 'what',
    title: 'What it is',
    body: (
      <>
        <p>
          Every capsuleer flies with a companion. For some it is Aura, who has talked them through every undock since
          the rookie ship. For others it is Claude, or ChatGPT. Aura MCP is how a companion reaches Edencom Link: a{' '}
          <a href="https://modelcontextprotocol.io">Model Context Protocol</a> (MCP) server, the open standard
          companions use to call tools outside themselves. Connect yours, and it can look at your hangars, wallets,
          industry jobs, blueprints, structures, fittings, market data and, if you allow it, your EVE mail, and answer
          questions about them in plain language.
        </p>
        <p>
          Aura MCP reads the same database the website reads. It never calls EVE&rsquo;s ESI API to read, so your
          companion sees exactly what the site holds for you, as fresh as the last extract. The one call it makes to ESI
          is to send a mail, below. Every tool runs under your own account, so your companion can see what you can see
          and nothing more.
        </p>
        <p className={styles.endpoint}>
          <span className={styles.label}>Server URL</span>
          <code>{SERVER_URL}</code>
        </p>
      </>
    ),
  },
  {
    id: 'before',
    title: 'Before you start',
    body: (
      <ul>
        <li>
          You need an Edencom Link account with at least one EVE character linked. Your companion can only read data
          that an extract has already pulled in, so link your characters first and let the jobs run.
        </li>
        <li>
          Signing in works through your browser. When you add the server, your companion opens a consent page on
          edencom.link. Sign in there as you normally would, approve the connection, and your companion is in. No API
          token to copy and nothing to paste.
        </li>
        <li>
          The connection is a credential. Anything your companion does through it, it does as you. Read the{' '}
          <a href="/terms#api">API Access</a> section of the Terms of Service before you connect one.
        </li>
      </ul>
    ),
  },
  {
    id: 'aura',
    title: 'Aura',
    body: (
      <>
        <p>
          Aura already speaks MCP. Ask Aura to add a connection, give it the server URL above, and Aura sends you to
          edencom.link to sign in and approve. That is the whole setup.
        </p>
        <p>
          From then on, when you ask Aura what your Jita hangar is worth or which jobs finish tonight, Aura looks it up
          in your own data instead of guessing.
        </p>
      </>
    ),
  },
  {
    id: 'claude',
    title: 'Claude',
    body: (
      <>
        <p>
          <strong>Claude.ai and the Claude apps.</strong> Open <em>Settings</em> → <em>Connectors</em> and choose{' '}
          <em>Add custom connector</em>. Name it Aura, paste the server URL, and save. Claude redirects you to
          edencom.link to sign in and approve. Once connected, turn the connector on in a conversation from the tools
          menu.
        </p>
        <p>
          <strong>Claude Code.</strong> From a terminal, add the server once and authenticate on first use:
        </p>
        <pre>
          <code>{`claude mcp add --transport http aura ${SERVER_URL}\nclaude\n/mcp`}</code>
        </pre>
        <p>
          The <code>/mcp</code> command lists the server and offers to sign in. Your browser opens the consent page;
          approve it and return to the terminal.
        </p>
      </>
    ),
  },
  {
    id: 'chatgpt',
    title: 'ChatGPT',
    body: (
      <>
        <p>
          ChatGPT connects to remote MCP servers through its <em>Connectors</em> feature. In <em>Settings</em> →{' '}
          <em>Connectors</em>, turn on <em>Developer mode</em> under <em>Advanced</em> if it is not already on, then
          choose <em>Create</em>, name it Aura and paste the server URL. Pick OAuth for authentication; leave the client
          id and secret empty, since the server registers clients on its own. ChatGPT sends you to edencom.link to sign
          in and approve.
        </p>
        <p>
          Connector support depends on your ChatGPT plan and may be limited to certain regions. If the option is not
          there, OpenAI has not enabled it for your account yet.
        </p>
      </>
    ),
  },
  {
    id: 'others',
    title: 'Cursor, VS Code and other clients',
    body: (
      <>
        <p>
          Any client that speaks MCP over Streamable HTTP with OAuth 2.1 can connect. Most of them read a small JSON
          configuration; the entry for Aura MCP looks like this:
        </p>
        <pre>
          <code>{`{\n  "mcpServers": {\n    "aura": {\n      "url": "${SERVER_URL}"\n    }\n  }\n}`}</code>
        </pre>
        <ul>
          <li>
            <strong>Cursor:</strong> put it in <code>.cursor/mcp.json</code> in a project, or{' '}
            <code>~/.cursor/mcp.json</code> for every project, then approve the sign-in prompt under <em>Settings</em> →{' '}
            <em>MCP</em>.
          </li>
          <li>
            <strong>VS Code (Copilot):</strong> run <em>MCP: Add Server</em> from the command palette, choose{' '}
            <em>HTTP</em>, and paste the server URL.
          </li>
          <li>
            <strong>Anything else:</strong> the server advertises its authorization server through{' '}
            <code>/.well-known/oauth-protected-resource</code> and supports dynamic client registration, so a client
            that follows the MCP authorization spec needs only the URL. There is no SSE endpoint and no API key mode.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'first',
    title: 'Your first conversation',
    body: (
      <>
        <p>
          Ask your companion to call <code>get_skill</code> first. It returns the operator&rsquo;s manual for Aura MCP:
          how EVE industry math works, where the data comes from, which tool answers which question, and how to write
          queries. Good companions do this on their own; a nudge never hurts.
        </p>
        <p>Then ask whatever you would have clicked around the site to find out:</p>
        <ul>
          <li>&ldquo;What is everything in my Jita hangar worth right now?&rdquo;</li>
          <li>&ldquo;Which of my blueprints could I research further, and which should I?&rdquo;</li>
          <li>&ldquo;What would it cost me to build ten Drakes at our Sotiyo, and what do I need to buy?&rdquo;</li>
          <li>&ldquo;Is anyone selling a fitted Loki on public contract near Amarr?&rdquo;</li>
          <li>&ldquo;Show me my corp&rsquo;s structure fuel and which ones run out this week.&rdquo;</li>
        </ul>
      </>
    ),
  },
  {
    id: 'tools',
    title: 'What your companion can do',
    body: (
      <>
        <p>
          Most tools only read. Four change something. <code>create_link</code> and <code>update_link</code> save a
          query as a Data Link under your account, and <code>edit_watched_systems</code> edits the watch list on your{' '}
          <a href="/indexes">cost indices</a> page. <code>send_mail</code> sends an EVE mail in the game as one of your
          characters, and only from a character you gave the opt-in <a href="/settings/grants">Send in-game mail</a>{' '}
          grant. Your companion is told to show you each mail and wait for your yes before it sends, and every mail is
          logged under your account before it goes. Nothing here can delete a fitting or change anything else in your
          EVE account.
        </p>
        <dl className={styles.tools}>
          {map(
            ({ title, tools }) => (
              <div key={title}>
                <dt>{title}</dt>
                <dd>{tools.join(', ')}</dd>
              </div>
            ),
            TOOL_GROUPS
          )}
        </dl>
        <p>
          Three tools leave the site to price things: the two appraisal tools and <code>shipping_quote</code> send item
          names and quantities, or route and cargo figures, to <a href="https://innomin.at">innomin.at</a> or KumGo.
          Nothing from your account goes with them. <code>send_mail</code> leaves the site too: it hands EVE the mail
          you agreed to, the same as your game client does. No other tool leaves the site.
        </p>
      </>
    ),
  },
  {
    id: 'privacy',
    title: 'Privacy and revoking access',
    body: (
      <>
        <p>
          Aura MCP holds no copy of your conversation. Your companion sends a tool call, the server answers from the
          database, and what your companion does with the answer is between you and its provider. Read that
          provider&rsquo;s privacy policy to understand how it keeps the data it receives.
        </p>
        <p>
          Your EVE mail is the most private thing Link keeps. Link copies it only for a character you gave the opt-in{' '}
          <a href="/settings/grants">Read in-game mail</a> grant, shows it on no page and shares it with no one, and{' '}
          <code>list_mail</code> and <code>read_mail</code> read it only for your own account.
        </p>
        <p>
          To disconnect, remove the connection in your companion. That is the only switch today: Link has no page
          listing the companions connected to your account yet, and a token a companion still holds works until it
          expires. If you think one has leaked, open an issue and we will revoke it by hand.
        </p>
        <p>
          Aura MCP, like the rest of Link, is open source. Read the tools in the{' '}
          <a href={`${REPO}/tree/main/src/app/api/mcp`}>repository</a>, or open an issue there if something does not
          connect.
        </p>
      </>
    ),
  },
]

const McpServerPage = () => (
  <main className={legal.wrap}>
    <h1>Aura MCP</h1>
    <p className={legal.updated}>Connect Aura, Claude, ChatGPT or whichever companion you fly with to your EVE data.</p>

    <h2>Contents</h2>
    <ol className={legal.contents}>
      {map(
        ({ id, title }) => (
          <li key={id}>
            <a href={`#${id}`}>{title}</a>
          </li>
        ),
        SECTIONS
      )}
    </ol>

    {map(
      ({ id, title, body }) => (
        <section key={id} id={id}>
          <h2>{title}</h2>
          {body}
        </section>
      ),
      SECTIONS
    )}
  </main>
)

export default McpServerPage
