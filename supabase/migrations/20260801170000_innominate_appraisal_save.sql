-- The asset viewer grows a "save and open this appraisal" arrow next to a
-- returned price: it re-runs the same batch with save: true, which makes
-- innomin.at store the appraisal and mint an id we can link a player to
-- (https://innomin.at/a/<id>). Every other appraisal in the app stays
-- side-effect free on the provider's side, as before.
--
-- The queue consumer is what actually calls the provider, so it needs to know
-- whether this request was a save — hence a column rather than something
-- derived. It's also part of the request key (src/innominateKey.ts), so a
-- cached unsaved result, which carries no appraisal id, can never satisfy a
-- save request; existing rows are all unsaved, which is what the default says.
alter table public.innominate_appraisal
  add column if not exists save boolean not null default false;
