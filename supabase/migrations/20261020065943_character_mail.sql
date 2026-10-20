-- character-mail (docs/eve-mail.md PR 2): a copy of each registered
-- character's EVE mailbox (headers, bodies, labels, mailing lists) and where
-- the backwards header walk stands. Owner-only reads, service-role writes, no
-- anon grant. mail_send_log (the send path's audit trail) is PR 3's.

-- ── character_mail (+ label / mailing list / sync) ────────────────────────
-- A copy of each registered character's EVE mailbox (docs/eve-mail.md),
-- written by the character-mail extract. The most personal thing this
-- database holds: owner-only reads, service-role writes, no anon grant, no
-- share table, no audience columns, and not in the Chancellor debug dump.
--
-- One row per mail the character can see. A header's facts are frozen at
-- delivery, so the row is upserted in place on (registration_id, mail_id)
-- like a contract's facts, not versioned; is_read and labels are overwritten
-- on every sighting (no history of when a mail was read). The body is fetched
-- once and stamped (body_fetched_at is set even when ESI answers 404, leaving
-- body null). Never deleted: a mail deleted in the client vanishes from the
-- listing and stays here — the copy is the feature. The one cascade is the
-- registration's. `recipients` is [{ recipient_id, recipient_type }] sorted by
-- (recipient_type, recipient_id) so two sightings compare equal; the body
-- keeps EVE's markup verbatim.
create table public.character_mail (
  registration_id  uuid   not null references public.registration(id) on delete cascade,
  mail_id          bigint not null,
  from_id          bigint not null,
  subject          text,
  sent_at          timestamptz not null,
  is_read          boolean not null default false,
  labels           bigint[] not null default '{}',
  recipients       jsonb   not null default '[]',
  body             text,
  body_fetched_at  timestamptz,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  primary key (registration_id, mail_id)
);
-- The body backlog the job drains, newest first.
create index character_mail_body_owed_idx
  on public.character_mail (registration_id, sent_at desc) where body_fetched_at is null;
create index character_mail_from_idx on public.character_mail (registration_id, from_id);
create index character_mail_sent_idx on public.character_mail (registration_id, sent_at desc);

-- The character's mail labels: 1/2/4/8 are the client's Inbox/Sent/Corp/
-- Alliance, higher ids the player's own folders. Upserted in place; a label
-- that disappears is left.
create table public.character_mail_label (
  registration_id uuid not null references public.registration(id) on delete cascade,
  label_id        bigint not null,
  name            text,
  color           text,
  unread_count    integer,
  primary key (registration_id, label_id)
);

-- The mailing lists the character is on — the only way a `mailing_list`
-- recipient id gets a name (universe/names does not know them).
create table public.character_mailing_list (
  registration_id uuid not null references public.registration(id) on delete cascade,
  mailing_list_id bigint not null,
  name            text,
  primary key (registration_id, mailing_list_id)
);

-- Where the backwards header walk stands for one character: ESI has no
-- "how many mails" call, so the first run's backfill is budgeted and resumed
-- from oldest_mail_id until a short page completes it.
create table public.character_mail_sync (
  registration_id   uuid primary key references public.registration(id) on delete cascade,
  oldest_mail_id    bigint,
  backfill_complete boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table public.character_mail         enable row level security;
alter table public.character_mail_label   enable row level security;
alter table public.character_mailing_list enable row level security;
alter table public.character_mail_sync    enable row level security;

create policy "Users read own mail"
  on public.character_mail
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
create policy "Users read own mail labels"
  on public.character_mail_label
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
create policy "Users read own mailing lists"
  on public.character_mailing_list
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
create policy "Users read own mail sync state"
  on public.character_mail_sync
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_mail         to authenticated;
grant select on public.character_mail_label   to authenticated;
grant select on public.character_mailing_list to authenticated;
grant select on public.character_mail_sync    to authenticated;
grant all    on public.character_mail         to service_role;
grant all    on public.character_mail_label   to service_role;
grant all    on public.character_mailing_list to service_role;
grant all    on public.character_mail_sync    to service_role;
