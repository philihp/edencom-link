-- Storage for the industry-planning spreadsheet's static CSVs (StaticInputs /
-- StaticOutputs / invention / types, in both twines and miros label modes),
-- derived from the sde_* mirror by the sde-mirror workflow's encodeSheets step
-- (src/jobs/sheetCsv.js -> encodeSheetCsv() in src/buildSheetCsv.js) after each
-- SDE build, and served at /sheets/[file] for Google Sheets =IMPORTDATA(). This
-- mirrors esf_data (20260718120000_add_esf_data.sql) but `data` holds the CSV
-- text directly — no base64, since CSV is already text, unlike esf_data's binary
-- protobufs. Public read (SDE-derived, no player data, identical for every
-- caller); writes are service-role only (the workflow).
create table public.sheet_csv (
  name text primary key,
  data text not null,
  sde_build bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.sheet_csv enable row level security;
create policy "Everyone reads sheet csv"
  on public.sheet_csv
  for select
  to anon, authenticated
  using (true);

grant select on public.sheet_csv to anon, authenticated;
grant all    on public.sheet_csv to service_role;
