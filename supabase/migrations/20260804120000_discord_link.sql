-- Discord integration stage 03 (docs/discord-bot/03-account-linking.md):
-- account↔channel linking via the /edencom slash command.
--
-- discord_link_code: short-lived (~10 min), single-use codes minted from
-- /account/settings and redeemed by `/edencom link <code>` in Discord — the
-- proof joining a Supabase account to the invoking Discord interaction.
-- Minted by the owner (authenticated insert), redeemed by the interactions
-- route (service role stamps redeemed_at).
--
-- discord_channel: one row = "this user's alerts go to this Discord channel."
-- Written only by the service role (the interactions route is the sole
-- writer); owners read and delete their own rows from settings. guild_name /
-- channel_name are display-only, denormalized from the interaction payload at
-- link time (nullable — Discord doesn't always include them). disabled_at is
-- stamped by the stage-05 sender when Discord reports the channel gone.
-- Snowflake ids are text: Discord delivers them as strings and they overflow
-- JS number precision.

create table public.discord_link_code (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz
);
create index discord_link_code_user_id_idx on public.discord_link_code (user_id);

alter table public.discord_link_code enable row level security;
create policy "Users read own link codes"
  on public.discord_link_code
  for select
  to authenticated
  using (user_id = (select auth.uid()));
create policy "Users mint own link codes"
  on public.discord_link_code
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

grant select, insert on public.discord_link_code to authenticated;
grant all           on public.discord_link_code to service_role;

create table public.discord_channel (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  guild_id text not null,
  channel_id text not null,
  guild_name text,
  channel_name text,
  linked_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  unique (user_id, channel_id)
);
create index discord_channel_user_id_idx on public.discord_channel (user_id);
create index discord_channel_channel_id_idx on public.discord_channel (channel_id);

alter table public.discord_channel enable row level security;
create policy "Users read own linked channels"
  on public.discord_channel
  for select
  to authenticated
  using (user_id = (select auth.uid()));
create policy "Users remove own linked channels"
  on public.discord_channel
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

grant select, delete on public.discord_channel to authenticated;
grant all            on public.discord_channel to service_role;
