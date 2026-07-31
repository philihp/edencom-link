-- Rename heartbeat.character_id to registration_id — step 4 of
-- docs/registration-id-rename.md. It has always held registration(id).
--
-- heartbeat was held back from the step-3 batch because it has two dependent
-- objects, one of them a category this codebase hadn't exercised:
--
--   * latest_heartbeats() returns `character_id uuid`. It's a classic
--     string-body SQL function, so its body is re-parsed at execution and a
--     rename would leave it selecting a column that no longer exists, failing
--     at the next query rather than here. CREATE OR REPLACE also can't change
--     a RETURNS TABLE column name (that's a return-type change), so it has to
--     be dropped and recreated outright. No policy calls it — it's reached
--     over RPC — so nothing has to be dropped ahead of it.
--
--   * owner_key is a GENERATED column whose expression references the renamed
--     column, and heartbeat_run_idx is UNIQUE on it. Postgres stores generated
--     expressions in pg_attrdef as parse trees keyed on attnum, exactly like
--     policy expressions and check constraints, so the rename should carry it.
--     But "should" is doing real work in that sentence: if it didn't, the
--     start/end heartbeat pair for every per-character run would stop matching
--     on the upsert key and silently double rather than erroring. So the
--     assertion below turns that assumption into a migration-time failure.

alter table public.heartbeat rename column character_id to registration_id;

-- Fail loudly here rather than corrupt heartbeat pairing quietly later.
do $$
declare
  expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid)
    into expr
  from pg_attrdef d
  join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = 'public.heartbeat'::regclass
    and a.attname = 'owner_key';

  if expr is null then
    raise exception 'heartbeat.owner_key has no generated expression — schema drifted from schema.sql';
  end if;
  if expr like '%character_id%' and expr not like '%registration_id%' then
    raise exception
      'heartbeat.owner_key still references character_id after the rename (%) — the generated expression did not follow, so heartbeat_run_idx would stop pairing start/end rows',
      expr;
  end if;
  if expr not like '%registration_id%' then
    raise exception 'heartbeat.owner_key does not reference registration_id (%)', expr;
  end if;
end $$;

alter index if exists public.heartbeat_character_id_idx rename to heartbeat_registration_id_idx;

drop function if exists public.latest_heartbeats();

create function public.latest_heartbeats()
returns table (job text, registration_id uuid, corporation_id bigint, ended_at timestamptz)
language sql
stable
as $$
  select distinct on (h.job, h.owner_key)
    h.job, h.registration_id, h.corporation_id, h.ended_at
  from public.heartbeat h
  where h.ended_at is not null
    and h.ended_at > now() - interval '30 days'
  order by h.job, h.owner_key, h.ended_at desc;
$$;

grant execute on function public.latest_heartbeats() to authenticated;
