-- mail_send_log gains the 'queued' status (docs/eve-mail.md "Approval on the
-- website"): MCP send_mail no longer calls ESI. It records the whole draft as
-- 'queued', and a person sends it later by hand (`pnpm run mail-send
-- --queued <id>`), which moves the row queued → pending → ok/error. 'pending'
-- keeps its meaning: the ESI call is in flight.
alter table public.mail_send_log drop constraint mail_send_log_status_check;
alter table public.mail_send_log
  add constraint mail_send_log_status_check check (status in ('queued', 'pending', 'ok', 'error'));
