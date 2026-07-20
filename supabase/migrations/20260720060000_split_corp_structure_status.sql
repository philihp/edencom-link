-- Split the volatile fuel timer off corp_structure into its own table so it can
-- keep a strict own-corp-only RLS policy while corp_structure itself opens up to
-- alliance-mates (policy added at the bottom). corp_structure_status points back
-- to the corp_structure row it describes.
create table if not exists public.corp_structure_status (
  structure_id bigint primary key references public.corp_structure (structure_id) on delete cascade,
  corporation_id bigint not null,
  fuel_expires timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists corp_structure_status_corporation_id_idx
  on public.corp_structure_status (corporation_id);

-- Move existing fuel data across before dropping the column.
insert into public.corp_structure_status (structure_id, corporation_id, fuel_expires, updated_at)
  select structure_id, corporation_id, fuel_expires, updated_at from public.corp_structure
  on conflict (structure_id) do nothing;

alter table public.corp_structure drop column if exists fuel_expires;

alter table public.corp_structure_status enable row level security;
-- Same scoping as corp_structure's own-corp policy: the player only sees fuel
-- for structures owned by a corporation one of their characters belongs to.
drop policy if exists "Users read structure status for own corps" on public.corp_structure_status;
create policy "Users read structure status for own corps"
  on public.corp_structure_status
  for select
  to authenticated
  using (
    corporation_id in (
      select corporation_id from public.registration
      where user_id = (select auth.uid()) and corporation_id is not null
    )
  );
grant select on public.corp_structure_status to authenticated;
grant all    on public.corp_structure_status to service_role;

-- Open corp_structure viewing to alliance-mates: a structure whose owning
-- corporation's alliance is one of the alliances the caller's own characters'
-- corporations belong to. Additive/permissive — OR'd with the existing own-corps
-- policy. Fuel stays private (corp_structure_status keeps the own-corps policy).
drop policy if exists "Alliance members read corp structures" on public.corp_structure;
create policy "Alliance members read corp structures"
  on public.corp_structure
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.corporation owner_corp
      where owner_corp.corporation_id = corp_structure.corporation_id
        and owner_corp.alliance_id is not null
        and owner_corp.alliance_id in (
          select member_corp.alliance_id
          from public.registration r
          join public.corporation member_corp on member_corp.corporation_id = r.corporation_id
          where r.user_id = (select auth.uid())
            and member_corp.alliance_id is not null
        )
    )
  );
