-- Skill levels per character, feeding the industry job-slot bubbles on the
-- character list. ESI /characters/{id}/skills/, written by the character-skills
-- job (also folded into character-status). Live current-state — a plain upsert
-- per skill (skills only ever level up and never leave a character), so no SCD
-- history table. Mirrors character_implant's shape and RLS.
create table if not exists public.character_skill (
  character_id uuid not null references public.registration(id) on delete cascade,
  skill_id bigint not null,
  active_skill_level smallint not null default 0,
  trained_skill_level smallint not null default 0,
  recorded_at timestamptz not null default now(),
  primary key (character_id, skill_id)
);

alter table public.character_skill enable row level security;

drop policy if exists "Users read own skills" on public.character_skill;
create policy "Users read own skills"
  on public.character_skill
  for select
  to authenticated
  using (
    character_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

grant select on public.character_skill to authenticated;
grant all    on public.character_skill to service_role;
