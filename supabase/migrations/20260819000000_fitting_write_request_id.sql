-- fitting_write_log.request_id — the client-minted key that makes a restore a PUT.
--
-- A restore creates a fitting inside EVE, and CCP assigns its id, so the caller
-- has no server-side id to address. A GUID the caller mints solves that: it
-- names the *attempt*, is unique by construction, and turns
-- `PUT /api/fittings/{characterId}/{requestId}` into a genuinely idempotent
-- write — a retry after a lost response replays onto the same row and returns
-- the fitting_id EVE already gave us, rather than saving a second copy.
--
-- Unique where present, because rows predating this column (and every delete,
-- which is addressed by the game's own fitting_id) carry null.
alter table public.fitting_write_log
  add column if not exists request_id uuid;

create unique index if not exists fitting_write_log_request_id_idx
  on public.fitting_write_log (request_id) where request_id is not null;
