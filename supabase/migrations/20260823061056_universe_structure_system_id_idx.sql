-- The GraphQL location filter now resolves a structure by system prefix plus
-- words from its name ("TKD Reactions"), which asks universe_structure for
-- every structure in ONE system — a predicate the table had no index for, and
-- it holds every player structure we have ever resolved. corp_structure is
-- small enough not to care; this one isn't.
create index if not exists universe_structure_system_id_idx
  on public.universe_structure (system_id);
