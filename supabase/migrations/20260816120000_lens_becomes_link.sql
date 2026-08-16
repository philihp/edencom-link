-- "Lens" becomes "Link": the product is EDENCOM Link, and the thing a
-- capsuleer registers — a saved query someone else may run on their behalf —
-- is a Link. One name for one concept, everywhere.
--
-- Structurally this is a rename and nothing else. Columns, policies' quals,
-- grants and the `enabled` share gate are untouched; Postgres carries the
-- dependent objects across a rename because they reference the relation by
-- oid, not by the text "lens".
alter table public.lens rename to link;
alter index lens_user_id_idx rename to link_user_id_idx;

alter policy "Users manage own lenses"          on public.link rename to "Users manage own links";
alter policy "Audience reads lenses aimed at them" on public.link rename to "Audience reads links aimed at them";

-- The dark-launch flag moves with the noun (src/flags.ts). Accounts already
-- carrying `lens` keep the capability under its new name; without this they
-- would silently lose the editor at deploy.
update public.user_settings
   set flags = array_replace(flags, 'lens', 'link')
 where flags @> array['lens'];
