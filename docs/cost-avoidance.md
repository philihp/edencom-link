# Cost avoidance on industry facility tax

The figure below the revenue on `/structure` — per structure on each tile
(attributed the same way the revenue is: journal entry → job → structure, and
visible under the same corp-ledger RLS), plus an account-wide total in the
footer. **Cost avoidance** is the accounting
term for an expense that was never incurred because a resource you already own
did the work — as distinct from a **cost saving**, which is a bill that got
smaller, and from **revenue**, which is money that actually arrived. Nothing
changes hands, so it sits beside the revenue rows rather than being added to
them. (The mirror-image concept, the notional charge for consuming an asset you
own, is an _imputed_ or _implicit_ cost; what we report is the difference
between that and the market price of renting the same capacity.)

Concretely: every industry job one of our characters or corporations installs in
a structure our corporations own pays our own members rate, into our own wallet.
The same job in somebody else's public structure would have paid their rate and
kept none of it. The gap is the expense avoided.

## Why the rates are typed in rather than extracted

They have to be. A structure's industry tax is configured in the client and CCP
publishes it through no official API:

- `/corporations/{id}/structures/` — the `services` array is `{name, state}` and
  nothing else. Property sets are byte-identical between the 2020 and 2026
  compatibility views of the spec.
- `/universe/structures/{id}/` — `name`, `owner_id`, `position`,
  `solar_system_id`, `type_id`.
- `/corporations/{id}/facilities/` — `facility_id`, `type_id`, `system_id`.
- `/industry/facilities/` — the one endpoint in the whole spec with a `tax`
  property, and a dead end: 2321 entries, all NPC stations, no id in the Upwell
  range, and `tax` absent on every row. It has not carried player structures
  since Citadels shipped.
- The corp wallet journal's `industry_job_tax` rows carry an amount, not a rate.

[esi-issues #110](https://github.com/esi/esi-issues/issues/110), "Determine
production tax rate and bonuses at a particular structure", has been open since
November 2016.

So `/settings/tax` holds two player-declared rates per account
(`user_settings.industry_tax_rate_own` / `_public`, fractions, defaulting to
0.1% and 1%). The public rate is a stated assumption about a counterfactual, not
a measurement — there is no honest way to make it one.

## Why the figure is derived from the tax receipt, not the job cost

The obvious arithmetic — job `cost` times the difference of the two rates — is
wrong, and wrong by a large factor rather than a rounding error.

ESI documents a job's `cost` as "the sum of job installation fee and industry
facility tax". But the facility tax is not levied on that fee. It is levied on
the job's **Estimated Item Value**, the ME0 material bill priced at CCP's
`adjusted_price`:

```
total cost = EIV × (system cost index × structure bonus + facility tax + SCC surcharge + alpha tax)
```

EIV is much larger than the fee, and we cannot compute it: it needs
`/markets/prices` → `adjusted_price`, which nothing here ingests (the
`market-prices` job pulls appraise.gnf.lt buy/sell, a different number). Using
`cost` as the base would understate the answer by roughly the size of the
bracket.

The tax receipt sits on the far side of that unknown. A journal `industry_job_tax`
amount **is** `EIV × own_rate`, so:

```
EIV     = tax_received / own_rate
avoided = EIV × (public_rate − own_rate)
        = tax_received × (public_rate / own_rate − 1)
```

which needs neither the EIV, the system cost index, the structure's role bonus,
nor the SCC surcharge. At the 0.1%/1% defaults it is nine times what we billed
ourselves. `src/app/structure/costAvoidance.ts` is that fold, tested in
`test/costAvoidance.test.ts`; a zero own rate leaves the figure unknowable
(there is no receipt to scale) rather than infinite.

## Which charges count, and why the sign is not the answer

`/structure` resolves each `industry_job_tax` entry to a job and thence to a
structure, unioning `character_industry_job` and `corp_industry_job` (ours) with
the `industry_job_tax_facility()` RPC (other players renting our slots). Only
the first two feed cost avoidance — a renter's tax is revenue, not a bill we
paid ourselves — so the page keeps the job id each entry matched on and checks
it against the set of our own.

The direction the ISK moved is a separate question from whose job it was, and
conflating the two used to zero the figure out entirely for the accounts most
entitled to it:

- **Positive.** Somebody paid tax into one of our structures. Always revenue;
  also an own-rate charge when the job was ours (a member installing a
  _personal_ job pays the fee from their own wallet into the corp's).
- **Negative, our own structure.** A job installed **as the corporation** bills
  the corp wallet, not the installer's. When that corporation also owns the
  structure, the ISK never leaves the entity and CCP writes only this outgoing
  side — there is no matching receipt anywhere in the journal. It is not
  revenue, but it is exactly the own-rate charge the counterfactual scales.
- **Negative, somebody else's structure.** We genuinely paid a landlord.
  Neither figure.

Reading receipts as "positive amounts only" therefore reported **no cost
avoidance at all** for a corporation that runs everything under corp ownership
in its own structures — the case the feature most exists for. It also made
`/structure/revenue` total such a day to a large negative number under a
heading that says "Revenue".

`src/app/structure/taxLedger.ts` is the fold that sorts entries into the three
buckets (tested in `test/taxLedger.test.ts`). The discriminator for an outgoing
entry is the structure's owning corporation against the corporation whose wallet
the entry sits in. Two of _our own_ corporations trading tax between themselves
fail that test deliberately: ISK really moved, and the receiving corp's journal
carries the positive side, which is where it gets counted. A job is credited at
most once regardless of how many entries name it, since a job can only be
charged its facility tax once.

## If this is ever wanted for a structure we don't own

Measuring a _third party's_ rate is possible, but only by installing a job there
and inverting your own job's cost:

```
their_rate = cost/EIV − system_cost_index × structure_bonus − 0.04 − alpha_tax
```

Every term on the right is knowable — but it needs the `/markets/prices`
`adjusted_price` extract that doesn't exist yet, and it only works for
manufacturing (copy/invention/research use different EIV bases). Not built.
