-- Close the Data API / GraphQL write surface that the schema's blanket default
-- privileges opened.
--
-- schema.sql sets `alter default privileges in schema public grant all on
-- tables to anon, authenticated, service_role` before creating anything, so
-- every table minted since has carried INSERT/UPDATE/DELETE (and SELECT) for
-- `anon` and `authenticated` regardless of the careful per-table `grant select
-- ... to authenticated` lines below it. That is why every table shows up in the
-- pg_graphql schema and in the Supabase advisor's
-- pg_graphql_{anon,authenticated}_table_exposed lints. RLS still gated the
-- data, so most of that exposure was cosmetic — with one exception that was
-- not.
--
-- ── The escalation: public.registration ───────────────────────────────────
-- Its policy is FOR ALL keyed only on user_id, and nothing constrains
-- character_id or corporation_id. Any account holding the `authenticated` role
-- — which includes anonymous sign-ins, since Supabase gives those the same
-- role — could POST /rest/v1/registration claiming another corporation and
-- satisfy every corp-scoped policy (corp_asset_over_time,
-- corp_blueprint_over_time, corp_industry_job_over_time, corp_contract,
-- corp_contract_item, corp_structure, corp_structure_rig,
-- corp_structure_status, corp_wallet_journal) plus
-- my_corporation_ids()/my_alliance_ids(), which widen the asset, fitting, den
-- and lens share audiences. Confirmed against production in a rolled-back
-- transaction: one forged row exposed 7,571 corp_wallet_journal rows for a corp
-- the account had no character in.
--
-- Locking corporation_id alone would not have fixed it: character-directory
-- resolves affiliations from registration.character_id with no ownership check,
-- so a forged character_id gets the victim's corp written back on the next cron
-- run. character_id is the authorization input, and the only thing that proves
-- it is the EVE SSO code exchange — an RS256 JWT that @philihp/eve-sso verifies
-- against CCP's JWKS. No extension on this project can verify RS256 in-database
-- (pgjwt is HMAC-only; pgcrypto and pgsodium have no RSA verify), so the check
-- has to happen in /character/callback, which now writes both tables with the
-- service role.
--
-- is_main stays user-writable as a column-level grant — it is the one field the
-- browser legitimately edits ("Set as Main" on /account/settings) and it feeds
-- no policy.
revoke insert, update, delete on public.registration from anon, authenticated;
grant update (is_main) on public.registration to authenticated;

-- token holds live EVE SSO refresh tokens. With the callback on the service
-- role, no user session needs this table at all: a browser that can read its
-- own refresh_token is an XSS-to-EVE-account bridge, and everything that reads
-- them is cron-side. The RLS policy stays as a second line of defence.
revoke all on public.token from anon, authenticated;

-- Orphaned pre-migration backup tables: referenced nowhere in the codebase,
-- exposed over the Data API, and their FOR ALL policies are granted to PUBLIC
-- (so `anon` as well, not just `authenticated`). token_backup is the reason
-- these are dropped rather than just revoked — it holds 22 rows of live EVE
-- refresh tokens, and stale credentials at rest are a liability whether or not
-- anything can currently reach them. asset_backup is empty; character_backup
-- holds 15 rows duplicated from registration.
drop table if exists public.token_backup;
drop table if exists public.character_backup;
drop table if exists public.asset_backup;

-- get_user_id_by_email is SECURITY DEFINER over auth.users, has no pinned
-- search_path, is referenced nowhere in the codebase, and is callable without
-- signing in via /rest/v1/rpc/get_user_id_by_email — an email-to-user_id
-- enumeration oracle. Dropped outright; nothing calls it.
drop function if exists public.get_user_id_by_email(text);

-- These four are service-role-only by design: RLS is on and they carry no
-- policy at all, so every anon/authenticated read already returned zero rows.
-- Revoking SELECT takes them out of the pg_graphql schema and the PostgREST
-- schema cache entirely, so they stop being discoverable rather than merely
-- unreadable. schema.sql already grants them only to service_role — it was the
-- blanket default privileges that put them on the API in the first place.
revoke select on public.esi_etag             from anon, authenticated;
revoke select on public.impersonation_log    from anon, authenticated;
revoke select on public.innominate_appraisal from anon, authenticated;
revoke select on public.innominate_throttle  from anon, authenticated;

-- ── The cosmetic-but-untidy rest ─────────────────────────────────────────
-- Every remaining public table that has no INSERT/UPDATE/DELETE policy still
-- carries the default write grants. RLS denies those writes today, so this
-- changes no behaviour; it removes the standing dependency on RLS being the
-- only thing between the anon key and a write, and shrinks what the advisor
-- and the GraphQL schema report. A DO block rather than a list because the
-- sde_* mirror tables are minted at runtime by ensure_sde_mirror_table()
-- (which already claws its own grants back the same way).
--
-- Read grants are deliberately left alone: `anon` SELECT is load-bearing for
-- the sde_* mirror, the world-readable directory tables (alliance, corporation,
-- character_directory, esf_data, industry_system_index) and the anonymous
-- share-link audiences.
do $$
declare r record;
begin
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_policy p
        where p.polrelid = c.oid and p.polcmd in ('a', 'w', 'd', '*')
      )
      and (
        has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE')
        or has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE')
      )
  loop
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', r.relname);
  end loop;
end $$;

-- Stop new tables inheriting the blanket grant, so each table's explicit
-- `grant select ... to authenticated` is the whole story from here on. Mirrors
-- the schema.sql change. This only affects tables created after it, which is
-- what the statements above are for. Sequence and function defaults are left
-- as they are: sequence USAGE is what lets an authenticated INSERT call
-- nextval() on a future serial column, and Postgres grants function EXECUTE to
-- PUBLIC by its own default anyway, so revoking here would buy nothing.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
