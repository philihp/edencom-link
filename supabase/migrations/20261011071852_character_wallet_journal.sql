-- character_wallet_journal: ESI /characters/{id}/wallet/journal/, the
-- character-side twin of corp_wallet_journal (no division — a character has one
-- wallet). Written by the character-wallet-journal job going forward and
-- backfilled from a jEveAssets profile export (src/jobs/importJeveJournal.js).
--
-- Why it exists: the industry_job_tax entries here are the facility tax a
-- character PAID the structure owner per job (context_id = job id), which the
-- corp journal only ever sees from the receiving side. /structure estimates
-- that charge today; this is the real figure, at any structure, back to 2022.
--
-- Keyed (registration_id, entry_id): an entry id is one in-game event, and a
-- transfer between two of our own characters lands in both journals under the
-- same id with opposite signs.
create table if not exists public.character_wallet_journal (
  registration_id uuid not null references public.registration(id) on delete cascade,
  entry_id bigint not null,
  date timestamptz not null,
  ref_type text not null,
  amount numeric(20, 2),
  balance numeric(20, 2),
  reason text,
  description text,
  first_party_id bigint,
  second_party_id bigint,
  context_id bigint,
  context_id_type text,
  tax numeric(20, 2),
  tax_receiver_id bigint,
  seen_at timestamptz not null default now(),
  primary key (registration_id, entry_id)
);
create index if not exists character_wallet_journal_registration_id_date_idx
  on public.character_wallet_journal (registration_id, date desc);
-- The job-id join /structure and /industry make: one entry per (job, ref_type).
create index if not exists character_wallet_journal_job_idx
  on public.character_wallet_journal (context_id, ref_type)
  where context_id_type = 'industry_job_id';

alter table public.character_wallet_journal enable row level security;
drop policy if exists "Users read own journal" on public.character_wallet_journal;
create policy "Users read own journal"
  on public.character_wallet_journal
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_wallet_journal to authenticated;
grant all    on public.character_wallet_journal to service_role;
