-- Momentum step 6: trailing stops, disaster-stop updates, exit review and exit tickets.

-- Disaster stop last placed at the broker (GTC stop-market); the page flags lots where it differs.
alter table public.ss_mom_lots add column if not exists disaster_posted real;
alter table public.ss_mom_lots add column if not exists stop_updated_on date;

-- Sell tickets reuse ss_mom_tickets (side = 'sell', kind = 'exit').
alter table public.ss_mom_tickets add column if not exists exit_trigger integer;
alter table public.ss_mom_tickets add column if not exists lots jsonb;          -- [{id, shares}]
alter table public.ss_mom_tickets add column if not exists shares_to_sell real;
alter table public.ss_mom_tickets add column if not exists deadline date;       -- last session to be out
alter table public.ss_mom_tickets add column if not exists urgent boolean not null default false;
alter table public.ss_mom_tickets add column if not exists xp1 real;
alter table public.ss_mom_tickets add column if not exists xp2 real;
