-- Notification outbox (Discord stage 04,
-- docs/discord-bot/04-reinforcement-detection.md). The generic shape from
-- docs/ntfy-notifications.md §1, plus a transport discriminator and the
-- Discord delivery target so fan-out is per-message: a user with N linked
-- channels gets N rows per event, each with its own delivery state. The ntfy
-- project later adds transport='ntfy' rows (discord_channel_id null) with no
-- schema change; its sweep filters on its own transport.
--
-- Rows are written by detection inside the extract jobs (service role), sit
-- pending until the stage-05 sender stamps sent_at, and dedupe on the partial
-- unique index below — detection treats a 23505 as success, so re-observing
-- the same reinforcement is a no-op while a changed timer (new source) pings
-- again. `nulls not distinct` so transports with no channel dedupe too.

create table public.notification (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,                 -- 'mercenary-den:<den_id>:<end unix>'
  transport text not null,              -- 'discord' | (future) 'ntfy'
  discord_channel_id uuid references public.discord_channel(id) on delete cascade,
  subject text not null,
  body text not null,
  scheduled_at timestamptz not null,    -- when it should go out; now() for immediate pings
  sent_at timestamptz,                  -- when it actually went out; null = pending
  attempts int not null default 0,      -- failed delivery tries (sender gives up past a cap)
  created_at timestamptz not null default now()
);

-- One *pending* row per (user, source, channel); sent history rows don't
-- block re-notifying the same source later.
create unique index notification_pending_source_idx
  on public.notification (user_id, source, discord_channel_id)
  nulls not distinct
  where sent_at is null;

-- The sender sweep's working set.
create index notification_due_idx
  on public.notification (scheduled_at)
  where sent_at is null;

create index notification_discord_channel_id_idx
  on public.notification (discord_channel_id);

alter table public.notification enable row level security;
create policy "Users manage own notifications"
  on public.notification
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.notification to authenticated;
grant all                            on public.notification to service_role;
