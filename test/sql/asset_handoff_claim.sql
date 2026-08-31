-- SQL-level coverage for character_asset_claim() — the rule that makes "an item
-- that changed hands is expired from its previous owner" true
-- (supabase/migrations/20260831043706_asset_handoff_claim.sql).
--
-- This is in SQL rather than node:test because the thing under test is the
-- interaction between a partial unique index and a statement pair, and the
-- branch that matters is the one the JS reconcile could never cover: the
-- previous owner is a *different* registration, so a lookup scoped to
-- `registration_id = me` cannot see the row that is about to collide. Testing
-- the JS classify pass would prove nothing about that; testing the claim
-- against the real index proves the thing the design leans on.
--
-- Run against a THROWAWAY database (it creates stand-in tables named after the
-- real ones in `public`) from the repo root:
--
--   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o '-k /tmp -p 55432' start
--   createdb -h /tmp -p 55432 claim
--   DATABASE_URL='postgresql://…/claim' pnpm run test:sql
--
-- Everything runs in one transaction and rolls back, so nothing is left behind.
begin;

-- A stand-in carrying the columns the claim touches. The real table
-- (schema.sql) adds a foreign key to registration and the SCD bookkeeping
-- columns; neither participates in the uniqueness rule.
create table public.character_asset_over_time (
  id bigint generated always as identity primary key,
  item_id bigint not null,
  registration_id uuid not null,
  type_id bigint not null,
  location_id bigint,
  location_flag text,
  location_type text,
  quantity bigint,
  is_singleton boolean,
  is_blueprint_copy boolean,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now(),
  name text
);

-- The index under test, verbatim from schema.sql:731. Note what it does NOT
-- say: registration_id. One open row per item across the whole table.
create unique index character_asset_over_time_current_item_idx
  on public.character_asset_over_time (item_id) where is_current;

-- The function under test, verbatim from the migration.
create or replace function public.character_asset_claim(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_items    bigint[];
  v_inserted integer;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  select array_agg(distinct (r->>'item_id')::bigint)
    into v_items
    from jsonb_array_elements(p_rows) r;

  perform pg_advisory_xact_lock(hashtext('public.character_asset_over_time')::bigint);

  update public.character_asset_over_time
     set is_current = false
   where is_current
     and item_id = any (v_items);

  insert into public.character_asset_over_time
    (item_id, registration_id, type_id, location_id, location_flag, location_type,
     quantity, is_singleton, is_blueprint_copy, valid_until, name)
  select (r->>'item_id')::bigint,
         (r->>'registration_id')::uuid,
         (r->>'type_id')::bigint,
         (r->>'location_id')::bigint,
         r->>'location_flag',
         r->>'location_type',
         (r->>'quantity')::bigint,
         (r->>'is_singleton')::boolean,
         coalesce((r->>'is_blueprint_copy')::boolean, false),
         coalesce((r->>'valid_until')::timestamptz, now()),
         r->>'name'
    from jsonb_array_elements(p_rows) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$$;

\set alice '11111111-1111-1111-1111-111111111111'
\set bob   '22222222-2222-2222-2222-222222222222'

-- ── The collision this exists to prevent ─────────────────────────────────
-- Alice holds item 900. A naive insert for Bob — what the old reconcile did,
-- because its lookup was scoped to Bob's own rows and so saw nothing — is
-- exactly the production failure: duplicate key on the partial unique index.
insert into public.character_asset_over_time (item_id, registration_id, type_id, quantity)
values (900, :'alice', 587, 1);

do $$
begin
  insert into public.character_asset_over_time (item_id, registration_id, type_id, quantity)
  values (900, '22222222-2222-2222-2222-222222222222', 587, 1);
  raise exception 'two open rows for one item_id were accepted';
exception
  when unique_violation then null;
end $$;

-- ── The handoff ──────────────────────────────────────────────────────────
-- The same claim through the function succeeds, and moves the item rather than
-- duplicating it.
select public.character_asset_claim(
  jsonb_build_array(jsonb_build_object(
    'item_id', 900, 'registration_id', :'bob', 'type_id', 587,
    'location_id', 60003760, 'location_flag', 'Hangar', 'location_type', 'station',
    'quantity', 1, 'is_singleton', false, 'is_blueprint_copy', false,
    'valid_until', now(), 'name', null
  )));

do $$
declare v_open int; v_alice_open int; v_bob_open int;
begin
  select count(*) into v_open
    from public.character_asset_over_time where item_id = 900 and is_current;
  select count(*) into v_alice_open
    from public.character_asset_over_time
   where item_id = 900 and is_current
     and registration_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into v_bob_open
    from public.character_asset_over_time
   where item_id = 900 and is_current
     and registration_id = '22222222-2222-2222-2222-222222222222';

  if v_open <> 1 then
    raise exception 'expected exactly one open row after handoff, got %', v_open;
  end if;
  if v_alice_open <> 0 then
    raise exception 'the previous owner still holds an open row';
  end if;
  if v_bob_open <> 1 then
    raise exception 'the new owner has no open row';
  end if;
end $$;

-- Alice keeps her history: the row is closed, not deleted, and its valid_until
-- is left where her last sighting put it.
do $$
declare v_closed int;
begin
  select count(*) into v_closed
    from public.character_asset_over_time
   where item_id = 900 and not is_current
     and registration_id = '11111111-1111-1111-1111-111111111111';
  if v_closed <> 1 then
    raise exception 'the previous owner lost their history row (found %)', v_closed;
  end if;
end $$;

-- ── A same-owner version change still works ──────────────────────────────
-- The claim is not special-cased to handoffs: re-claiming for the current owner
-- closes their old row and opens the new version, which is what a moved or
-- restacked item does.
select public.character_asset_claim(
  jsonb_build_array(jsonb_build_object(
    'item_id', 900, 'registration_id', :'bob', 'type_id', 587,
    'location_id', 60003760, 'location_flag', 'Cargo', 'location_type', 'station',
    'quantity', 7, 'is_singleton', false, 'is_blueprint_copy', false,
    'valid_until', now(), 'name', null
  ))
);

do $$
declare v_open int; v_flag text; v_qty bigint;
begin
  select count(*) into v_open
    from public.character_asset_over_time where item_id = 900 and is_current;
  if v_open <> 1 then
    raise exception 'a same-owner re-claim left % open rows', v_open;
  end if;
  select location_flag, quantity into v_flag, v_qty
    from public.character_asset_over_time where item_id = 900 and is_current;
  if v_flag <> 'Cargo' or v_qty <> 7 then
    raise exception 'the open row is not the new version (flag=%, qty=%)', v_flag, v_qty;
  end if;
end $$;

-- ── A batch claims every item in it ──────────────────────────────────────
-- Items 901 and 902 start under Alice; one batch moves both to Bob alongside a
-- brand-new item 903 that nobody held.
insert into public.character_asset_over_time (item_id, registration_id, type_id, quantity)
values (901, :'alice', 34, 100), (902, :'alice', 35, 200);

-- The return value is the number of rows opened, which the job logs as
-- `opened` — three here, not the two that changed hands. Asserted inside the
-- same block as the claim because psql does not interpolate :variables into a
-- dollar-quoted body, so \gset cannot carry the result into one.
do $$
declare v_bob int; v_alice int; v_opened int;
begin
  v_opened := public.character_asset_claim(
    jsonb_build_array(
      jsonb_build_object('item_id', 901, 'registration_id', '22222222-2222-2222-2222-222222222222', 'type_id', 34, 'quantity', 100),
      jsonb_build_object('item_id', 902, 'registration_id', '22222222-2222-2222-2222-222222222222', 'type_id', 35, 'quantity', 200),
      jsonb_build_object('item_id', 903, 'registration_id', '22222222-2222-2222-2222-222222222222', 'type_id', 36, 'quantity', 300)
    )
  );
  if v_opened <> 3 then
    raise exception 'claim reported % rows opened, expected 3', v_opened;
  end if;
  select count(*) into v_bob
    from public.character_asset_over_time
   where item_id in (901, 902, 903) and is_current
     and registration_id = '22222222-2222-2222-2222-222222222222';
  select count(*) into v_alice
    from public.character_asset_over_time
   where item_id in (901, 902) and is_current
     and registration_id = '11111111-1111-1111-1111-111111111111';
  if v_bob <> 3 then
    raise exception 'expected 3 open rows for the claimant, got %', v_bob;
  end if;
  if v_alice <> 0 then
    raise exception 'the previous owner kept % open rows', v_alice;
  end if;
end $$;

-- ── Empty input is a no-op, not an error ─────────────────────────────────
-- The reconcile calls this unconditionally; a run where nothing changed sends
-- an empty batch, and a null can reach it through PostgREST.
do $$
begin
  if public.character_asset_claim('[]'::jsonb) <> 0 then
    raise exception 'an empty batch reported rows opened';
  end if;
  if public.character_asset_claim(null) <> 0 then
    raise exception 'a null batch reported rows opened';
  end if;
end $$;

rollback;
