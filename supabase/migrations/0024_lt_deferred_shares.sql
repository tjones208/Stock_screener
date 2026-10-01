-- Shares a deferred trim (triggers 7 / 9) would have sold from the lot, so it can be worked on lt_date.
alter table public.ss_mom_lots add column if not exists lt_deferred_shares real;
