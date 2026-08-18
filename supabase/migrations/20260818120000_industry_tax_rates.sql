-- Industry facility tax rates, for the cost-avoidance figure on /structure.
--
-- What a structure owner charges for a job is configured in the client and
-- CCP exposes it nowhere: neither /corporations/{id}/structures/ (its
-- `services` array carries a name and a state, nothing else) nor
-- /universe/structures/{id}/ nor either industry-jobs endpoint reports the
-- rate. So the two rates that the comparison needs are declared by the player
-- rather than extracted, one pair per account:
--
--   own    — what the account's own characters pay to run a job in a
--            structure the account's corporations own (0.1% is the usual
--            "members" setting).
--   public — what they would have paid renting slots from someone else's
--            structure instead (1% is the usual public rate).
--
-- Fractions, not percents: 0.001 is 0.1%. The check bounds them either side of
-- what the client itself allows, so a mistyped percent (10 for "10%") can't
-- silently multiply the figure by a hundred.
alter table public.user_settings
  add column if not exists industry_tax_rate_own    numeric(6, 5) not null default 0.001,
  add column if not exists industry_tax_rate_public numeric(6, 5) not null default 0.01;

alter table public.user_settings
  drop constraint if exists user_settings_industry_tax_rates_sane;
alter table public.user_settings
  add constraint user_settings_industry_tax_rates_sane
  check (
    industry_tax_rate_own    between 0 and 1
    and industry_tax_rate_public between 0 and 1
  );

comment on column public.user_settings.industry_tax_rate_own is
  'Facility tax fraction this account pays in its own structures (0.001 = 0.1%). Player-declared: ESI does not expose structure tax rates.';
comment on column public.user_settings.industry_tax_rate_public is
  'Facility tax fraction this account would pay in a public structure (0.01 = 1%). Player-declared, as above.';
