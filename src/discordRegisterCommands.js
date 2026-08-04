// One-off utility (DB/token-utilities family, like connect/ping/refresh):
// registers the /edencom slash command with Discord. Commands are data held by
// Discord, not code — run this once after changing the command shape below.
//
//   node src/discordRegisterCommands.js               # global (~1h to propagate)
//   node src/discordRegisterCommands.js --guild <id>  # instant, one test server
//
// Needs DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment. The handler
// answering these commands is src/app/api/discord/interactions/route.ts.
import { indexOf } from 'ramda'

// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type
const SUB_COMMAND = 1
const STRING = 3

const commands = [
  {
    name: 'edencom',
    description: 'Edencom.link — query the SDE and your EVE Online ESI data',
    options: [
      {
        type: SUB_COMMAND,
        name: 'link',
        description: 'Send den alerts to this channel (get a code from Edencom.link settings)',
        options: [
          {
            type: STRING,
            name: 'code',
            description: 'Link code from your Edencom.link account settings',
            required: true,
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'unlink',
        description: 'Stop sending Edencom.link alerts to this channel',
      },
    ],
  },
]

const appId = process.env.DISCORD_APP_ID
const botToken = process.env.DISCORD_BOT_TOKEN
if (!appId || !botToken) {
  console.error('DISCORD_APP_ID and DISCORD_BOT_TOKEN must be set')
  process.exit(1)
}

const guildFlag = indexOf('--guild', process.argv)
const guildId = guildFlag === -1 ? undefined : process.argv[guildFlag + 1]
if (guildFlag !== -1 && !guildId) {
  console.error('--guild needs a guild id')
  process.exit(1)
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`

// PUT replaces the full command list, so removals propagate too.
const response = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
})

const body = await response.json()
if (!response.ok) {
  console.error(`Discord rejected the command list (${response.status}):`, JSON.stringify(body, null, 2))
  process.exit(1)
}
console.log(
  `Registered ${body.length} command(s) ${guildId ? `on guild ${guildId} (instant)` : 'globally (may take ~1h to propagate)'}`
)
