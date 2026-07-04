-- Attribute a heartbeat row to the character/corp/user a per-character or
-- per-corp job ran it for (null for whole-job/account-wide runs). owner_key
-- folds the two nullable id columns into a single non-null discriminator so
-- the start/end upsert (keyed on job, run_id, run_attempt, owner_key) still
-- pairs correctly per entity instead of collapsing every character/corp in
-- a run onto one row. duration is a convenience for "how long did this run
-- take" once ended_at lands. Mirrors the columns added to schema.sql.
alter table public.heartbeat
  add column if not exists character_id uuid references public.registration(id) on delete cascade,
  add column if not exists corporation_id bigint,
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

alter table public.heartbeat
  add column if not exists owner_key text
    generated always as (coalesce(character_id::text, '') || '|' || coalesce(corporation_id::text, '')) stored;

alter table public.heartbeat
  add column if not exists duration interval generated always as (ended_at - started_at) stored;

drop index if exists heartbeat_run_idx;
create unique index if not exists heartbeat_run_idx on public.heartbeat (job, run_id, run_attempt, owner_key);
create index if not exists heartbeat_character_id_idx on public.heartbeat (character_id);
create index if not exists heartbeat_corporation_id_idx on public.heartbeat (corporation_id);

-- Tighten the previously "any authenticated user can read every heartbeat
-- row" policy now that rows can carry per-user/per-corp identity: whole-job
-- rows (user_id null) stay visible to everyone, a per-character row is
-- visible only to its owner, and a per-corp row to anyone with a character
-- in that corp (mirrors the corp_structure/corp_asset RLS convention).
drop policy if exists "Authenticated read heartbeat" on public.heartbeat;
create policy "Authenticated read heartbeat"
  on public.heartbeat
  for select
  to authenticated
  using (
    user_id is null
    or user_id = (select auth.uid())
    or corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );
