-- Skill levels per character, feeding the industry job-slot bubbles on the
-- character list. ESI /characters/{id}/skills/, written by the character-skills
-- job (also folded into character-status). SCD Type 2, mirroring
-- character_ship_over_time: one open (is_current) row per (character, skill),
-- valid_until bumped when the level is unchanged and a new version opened on a
-- level change. A skill is never unlearned, so a row is only ever superseded,
-- never closed for vanishing. The character_skill view is the live snapshot.
create table if not exists public.character_skill_over_time (
  id bigint generated always as identity primary key,
  character_id uuid not null references public.registration(id) on delete cascade,
  skill_id bigint not null,
  active_skill_level smallint not null default 0,
  trained_skill_level smallint not null default 0,
  is_current boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null default now()
);
create index if not exists character_skill_over_time_character_id_idx
  on public.character_skill_over_time (character_id);
create unique index if not exists character_skill_over_time_current_idx
  on public.character_skill_over_time (character_id, skill_id) where is_current;

alter table public.character_skill_over_time enable row level security;

drop policy if exists "Users read own skills" on public.character_skill_over_time;
create policy "Users read own skills"
  on public.character_skill_over_time
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

create or replace view public.character_skill with (security_invoker = on) as
  select * from public.character_skill_over_time where is_current;

grant select on public.character_skill_over_time to authenticated;
grant select on public.character_skill           to authenticated;
grant all    on public.character_skill_over_time to service_role;
