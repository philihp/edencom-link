-- Replays 20260805010000_asset_share_recursive_rls.sql, which never applied.
--
-- WHAT HAPPENED. Two PRs merged carrying the same migration version:
-- 20260805010000_gice_account.sql (#802) and
-- 20260805010000_asset_share_recursive_rls.sql (#801). #802 merged first and
-- recorded version 20260805010000 in supabase_migrations.schema_migrations;
-- when #801 merged, `supabase db push` computed its pending set by diffing
-- local file VERSIONS against the versions already in the history table, saw
-- 20260805010000 present, and treated the recursive-RLS file as applied. The
-- Migrate workflow went green having silently skipped it, so production ran
-- with character_asset_share rows that no policy consulted: every share
-- resolved to zero visible rows.
--
-- WHY THE EXISTING GUARDS DIDN'T CATCH IT. Neither is wrong; the case falls
-- between them.
--   * .github/scripts/check-migrations.mjs rejects a version that collides with
--     one already on main, but #801 and #802 were open simultaneously and each
--     validated against a main that did not yet contain the other. This is the
--     exact gap CLAUDE.md names: "two open PRs carrying the same new timestamp
--     both pass the check against main, then collide on merge."
--   * 20260727000000_migration_history_composite_key.sql widened the history
--     key to (version, name) so a colliding INSERT records both rows instead of
--     aborting every later push. That backstop addresses the loud failure mode.
--     This was the quiet one — the CLI never attempted the insert, because it
--     never selected the file as pending in the first place.
--
-- WHY THIS IS A NEW FILE. Renaming 20260805010000_asset_share_recursive_rls.sql
-- to a free timestamp would look like the tidier fix and is the documented trap
-- (CLAUDE.md, Workflow): a filename is a migration's identity to every database
-- that may already have applied it, so a rename only relocates the mismatch
-- between local, CI and remote. The old file keeps its name and its recorded
-- history entry stays as-is; this file carries the DDL forward.
--
-- Everything below is idempotent, so the from-scratch replay path — where the
-- 20260805010000 file DOES apply, then this one follows — is a no-op rather
-- than a duplicate-object error. schema.sql already carries this DDL (it landed
-- with #801) and is unchanged.

-- Identical to the function in 20260805010000_asset_share_recursive_rls.sql;
-- see that file's header for the SECURITY DEFINER rationale (it is the single
-- sanctioned definer: an invoker-rights helper selecting from the table it
-- policies re-enters that policy and Postgres aborts with "infinite recursion
-- detected in policy"). `create or replace` makes the replay a no-op.
create or replace function public.asset_share_covers(item bigint, registration uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    matching_shares as (
      select s.item_id
      from character_asset_share s
      where s.registration_id = asset_share_covers.registration
        and asset_share_matches_caller(s.corporation_ids, s.alliance_ids, s.secret)
    ),
    walk (node, depth) as (
      select asset_share_covers.item, 0
      union all
      select parent.location_id, w.depth + 1
      from walk w
      cross join lateral (
        select o.location_id
        from character_asset_over_time o
        where o.item_id = w.node
        order by o.is_current desc, o.valid_until desc
        limit 1
      ) parent
      where w.depth < 16
        and parent.location_id is not null
        and exists (select 1 from matching_shares)
    )
  select exists (
    select 1
    from walk w
    join matching_shares m on m.item_id = w.node
  );
$$;

revoke execute on function public.asset_share_covers(bigint, uuid) from public;
grant execute on function public.asset_share_covers(bigint, uuid) to anon, authenticated;

-- The widening policy. is_current keeps SCD-2 history closed: a share opens the
-- CURRENT view only — the same rows character_asset shows the owner.
-- Permissive, so it ORs with "Users read own assets". `to anon` so a
-- fully-public share is readable signed-out. The drop-if-exists is what makes
-- this replayable; create policy has no `or replace`.
drop policy if exists "Audience reads shared assets" on public.character_asset_over_time;

create policy "Audience reads shared assets"
  on public.character_asset_over_time
  for select
  to anon, authenticated
  using (is_current and public.asset_share_covers(item_id, registration_id));

-- RLS still scopes anon to rows a public share covers (the owner policy never
-- matches a null uid). Already true on the remote via the schema-wide default
-- privileges, but restated so a from-scratch database does not depend on them.
grant select on public.character_asset_over_time to anon;
grant select on public.character_asset           to anon;
