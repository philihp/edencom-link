// The chart of accounts and the ref_type map of the cash ledger (ledger stage
// 2, docs/ledger/stage-2.md). The same two lists are the seeds of
// `ledger_account` and `ledger_ref_type` in the migration and in schema.sql;
// test/ledgerChart.test.ts proves that the three agree.
//
// `otherAccount` is the rule of the view `ledger_cash_line` for the other
// line of a journal row, so a pure fold can use it without the database.
import { find, propEq } from 'ramda'

export type AccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export type Account = { code: string; name: string; kind: AccountKind; parent: string | null }

export const SUSPENSE = '9000'
export const CHARACTER_CASH = '1000'
export const CORPORATION_CASH = '1010'

export const ACCOUNTS: readonly Account[] = [
  { code: '1000', name: 'Cash', kind: 'asset', parent: null },
  { code: '1010', name: 'Cash: corporation division', kind: 'asset', parent: '1000' },
  { code: '1100', name: 'Market escrow', kind: 'asset', parent: null },
  { code: '1200', name: 'Inventory', kind: 'asset', parent: null },
  { code: '1210', name: 'Inventory: work in progress', kind: 'asset', parent: '1200' },
  { code: '1300', name: 'Contract collateral held', kind: 'asset', parent: null },
  { code: '1400', name: 'Receivables', kind: 'asset', parent: null },
  { code: '2000', name: 'Payables', kind: 'liability', parent: null },
  { code: '2100', name: 'Contract collateral owed', kind: 'liability', parent: null },
  { code: '3000', name: 'Opening balance equity', kind: 'equity', parent: null },
  { code: '3100', name: 'Intercompany', kind: 'equity', parent: null },
  { code: '4000', name: 'Revenue: market sales', kind: 'revenue', parent: null },
  { code: '4100', name: 'Revenue: contract sales', kind: 'revenue', parent: null },
  { code: '4200', name: 'Revenue: services', kind: 'revenue', parent: null },
  { code: '4300', name: 'Revenue: bounties and loot', kind: 'revenue', parent: null },
  { code: '4400', name: 'Revenue: insurance', kind: 'revenue', parent: null },
  { code: '4900', name: 'Other income', kind: 'revenue', parent: null },
  { code: '5000', name: 'Cost of goods sold', kind: 'expense', parent: null },
  { code: '5100', name: 'Broker fees', kind: 'expense', parent: null },
  { code: '5110', name: 'Sales tax', kind: 'expense', parent: null },
  { code: '5120', name: 'Contract fees', kind: 'expense', parent: null },
  { code: '5200', name: 'Industry: install fees', kind: 'expense', parent: null },
  { code: '5210', name: 'Industry: facility tax', kind: 'expense', parent: null },
  { code: '5300', name: 'Structure fuel and services', kind: 'expense', parent: null },
  { code: '5400', name: 'Clones and medical', kind: 'expense', parent: null },
  { code: '5500', name: 'Office and rent', kind: 'expense', parent: null },
  { code: '5600', name: 'Transport and courier', kind: 'expense', parent: null },
  { code: '5900', name: 'Other expense', kind: 'expense', parent: null },
  { code: '9000', name: 'Suspense: unclassified', kind: 'equity', parent: null },
]

export type RefType = {
  refType: string
  // The other account when amount > 0 (and when amount = 0).
  accountIn: string | null
  // The other account when amount < 0.
  accountOut: string | null
  // Moves ISK between two parties, and can be internal to a group.
  transfer: boolean
  // Stage 0 measured the behaviour (H3, H4, H6).
  verified: boolean
  note: string
}

const rt = (
  refType: string,
  accountIn: string | null,
  accountOut: string | null,
  transfer: boolean,
  verified: boolean,
  note: string
): RefType => ({ refType, accountIn, accountOut, transfer, verified, note })

// The 61 ref_types of the census (H10, lab copy of 2026-11-22), in order of
// ISK moved. A side the census never saw still has an account where the
// meaning is clear: a refund of a fee goes back to the fee's account, a
// clawback of income to the income's account.
export const REF_TYPES: readonly RefType[] = [
  rt(
    'player_donation',
    '4900',
    '5900',
    true,
    true,
    'H4: both sides share the entry id. Internal ones are left out of the group.'
  ),
  rt(
    'market_escrow',
    '1100',
    '1100',
    false,
    true,
    'H6: a buy from a sell order, and a buy order placed; in is escrow returned.'
  ),
  rt(
    'market_transaction',
    '4000',
    '1200',
    false,
    true,
    'H6: a sale. No out row seen; it would be a purchase (inventory, stage 6).'
  ),
  rt(
    'contract_price',
    '4100',
    '1200',
    true,
    true,
    'H4: both sides share the entry id. Out buys items (inventory, stage 6).'
  ),
  rt(
    'contract_price_payment_corp',
    '4100',
    '1200',
    false,
    false,
    'A contract price paid to the character for the corporation; no pair seen.'
  ),
  rt('manufacturing', '5200', '5200', false, false, 'Job install fee.'),
  rt('contract_reward_deposited', '5600', '5600', false, false, 'Courier reward put up by the issuer.'),
  rt('contract_reward', '4200', '4200', false, false, 'Courier reward received.'),
  rt(
    'corporation_account_withdrawal',
    '4900',
    '5900',
    true,
    false,
    'Corporation to character. Internal when the corporation is in the group.'
  ),
  rt('transaction_tax', '5110', '5110', false, false, 'Sales tax; one-cent rounding (H2).'),
  rt('reaction', '5200', '5200', false, false, 'Job install fee.'),
  rt('brokers_fee', '5100', '5100', false, false, 'No context id (H7).'),
  rt(
    'industry_job_tax',
    '4200',
    '5210',
    true,
    true,
    'H4: character to corporation pairs on the entry id; a corporation paying itself has a hidden credit (stage 1).'
  ),
  rt('contract_reward_refund', '5600', '5600', false, false, 'Courier reward returned to the issuer.'),
  rt('market_provider_tax', '5100', '5100', false, false, 'The structure owner share of the broker fee.'),
  rt('researching_time_productivity', '5200', '5200', false, false, 'Job install fee.'),
  rt('researching_material_productivity', '5200', '5200', false, false, 'Job install fee.'),
  rt('copying', '5200', '5200', false, false, 'Job install fee.'),
  rt('skill_purchase', '5900', '5900', false, false, 'Skill books from the NPC.'),
  rt('researching_technology', '5200', '5200', false, false, 'Invention install fee.'),
  rt('insurance', '4400', '5900', false, false, 'In: a payout. Out: a premium.'),
  rt('contract_collateral_payout', '4900', '4900', false, false, 'Collateral kept from a failed courier.'),
  rt('contract_collateral', '1300', '1300', false, false, 'Collateral put up as the hauler.'),
  rt('reprocessing_tax', '5900', '5900', false, false, 'Reprocessing tax.'),
  rt('contract_collateral_refund', '1300', '1300', false, false, 'Collateral returned to the hauler.'),
  rt('planetary_export_tax', '5900', '5900', false, false, 'Planetary industry.'),
  rt('player_trading', '4100', '1200', true, true, 'H4: both sides share the entry id. 28,795 rows are zero.'),
  rt('contract_deposit', '1400', '1400', false, false, 'Contract deposit, returned by contract_deposit_refund.'),
  rt('cosmetic_market_skin_transaction', '4900', '5900', false, false, 'SKIN market.'),
  rt('contract_brokers_fee', '5120', '5120', false, false, 'Contract broker fee.'),
  rt('planetary_construction', '5900', '5900', false, false, 'Planetary industry.'),
  rt('contract_auction_bid', '1400', '1400', false, false, 'Bid held until the auction ends.'),
  rt('bounty_prizes', '4300', '4300', false, true, 'H3: amount is already net of tax.'),
  rt('contract_deposit_refund', '1400', '1400', false, false, 'Contract deposit returned.'),
  rt('daily_goal_payouts', '4900', '4900', false, false, 'Daily goals.'),
  rt('ess_escrow_transfer', '4300', '4300', false, false, 'ESS bounty share.'),
  rt('office_rental_fee', '4200', '5500', false, false, 'In: an office rented to others. Out: our office.'),
  rt('contract_sales_tax', '5110', '5110', false, false, 'Contract sales tax.'),
  rt('planetary_import_tax', '5900', '5900', false, false, 'Planetary industry.'),
  rt('corporate_reward_payout', '4900', '4900', false, false, 'Corporation project reward.'),
  rt('project_payouts', '4900', '4900', false, false, 'Corporation project payout.'),
  rt('freelance_jobs_reward_escrow', '1400', '1400', false, false, 'Freelance job reward held.'),
  rt('asset_safety_recovery_tax', '5900', '5900', false, false, 'Asset safety.'),
  rt(
    'jump_clone_activation_fee',
    '4200',
    '5400',
    false,
    false,
    'In: our clone bay. Out: a clone jump. No pair on the entry id.'
  ),
  rt('freelance_jobs_reward', '4200', '4200', false, false, 'Freelance job reward.'),
  rt('structure_gate_jump', '5600', '5600', false, false, 'Ansiblex toll.'),
  rt('jump_clone_installation_fee', '4200', '5400', false, false, 'In: our clone bay. Out: a clone installed.'),
  rt('flux_ticket_sale', '5900', '5900', false, false, 'Flux tickets.'),
  rt('freelance_jobs_broadcasting_fee', '5900', '5900', false, false, 'Freelance job fee.'),
  rt('freelance_jobs_duration_fee', '5900', '5900', false, false, 'Freelance job fee.'),
  rt('allignment_based_gate_toll', '5600', '5600', false, false, 'Gate toll (the ESI spelling).'),
  rt('agent_mission_reward', '4300', '4300', false, false, 'Mission reward.'),
  rt('agent_mission_time_bonus_reward', '4300', '4300', false, false, 'Mission bonus.'),
  rt('air_career_program_reward', '4900', '4900', false, false, 'AIR career program.'),
  rt('project_discovery_reward', '4900', '4900', false, false, 'Project Discovery.'),
  rt('gm_cash_transfer', '4900', '5900', false, false, 'A transfer by a GM.'),
  rt('contract_auction_bid_refund', '1400', '1400', false, false, 'Auction bid returned.'),
  rt('achievement_milestone_reward', '4900', '4900', false, false, 'Achievement reward.'),
  rt('cosmetic_market_skin_sale_broker_fee', '5100', '5100', false, false, 'SKIN market broker fee.'),
  rt('repair_bill', '5900', '5900', false, false, 'Repair.'),
  rt('cosmetic_market_skin_sale_tax', '5110', '5110', false, false, 'SKIN market sales tax.'),
]

// The account of the other line of a journal row: by the sign of the amount
// (zero uses accountIn), and Suspense when the ref_type or the side has none.
export const otherAccount = (refType: string, amount: number): string => {
  const row = find(propEq(refType, 'refType'), REF_TYPES)
  const account = amount >= 0 ? row?.accountIn : row?.accountOut
  return account ?? SUSPENSE
}

export const cashAccount = (kind: 'character' | 'corporation'): string =>
  kind === 'character' ? CHARACTER_CASH : CORPORATION_CASH
