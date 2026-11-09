use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

const T0_MS: u64 = 1_700_000_000_000;
const HOUR_MS: u64 = 3_600_000;

fn ctx_at(caller: &str, deposit: u128, ms: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(caller))
        .current_account_id(acc("park.testnet"))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ms * 1_000_000)
        .build());
}

/// Actions after setup happen an hour later (parks need real time to pass before days can settle).
fn ctx(caller: &str, deposit: u128) {
    ctx_at(caller, deposit, T0_MS + HOUR_MS);
}

const ADMIN: &str = "admin.testnet";
const PARK: &str = "abcd1234abcd1234";

fn setup() -> Contract {
    ctx_at(ADMIN, 0, T0_MS);
    let mut c = Contract::new(acc(ADMIN));
    c.register_park(PARK.into(), "Meadowbrook".into(), Some(acc("alice.testnet")));
    c.set_patron(acc("p0.park.testnet"), U128(50_000), true);
    c.set_patron(acc("p1.park.testnet"), U128(50_000), true);
    c.fund_patrons(vec![acc("p0.park.testnet"), acc("p1.park.testnet")], U128(100_000));
    c
}

fn line(venue: &str, amount: u128) -> SettleLine {
    SettleLine { venue: venue.into(), amount: U128(amount) }
}

fn conserved(c: &Contract) {
    let escrow: u128 = c.parks.values().map(|p| p.balance.0).sum();
    assert_eq!(escrow, c.escrow_total, "escrow_total tracks park balances");
    let held = ["p0.park.testnet", "p1.park.testnet", "alice.testnet", "bob.testnet", "carol.testnet"].iter().map(|a| c.balance(&acc(a))).sum::<u128>();
    assert_eq!(escrow + held, c.total_supply, "credits must be conserved");
}

#[test]
fn settles_a_day_into_the_park() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    let paid = c.settle_day(PARK.into(), 3, vec![line("r12", 1500), line("gate", 500)], "abc123".into());
    assert_eq!(paid.0, 2000);
    let p = c.get_park(PARK.into()).unwrap();
    assert_eq!(p.balance.0, 2000);
    assert_eq!(p.earned.0, 2000);
    assert_eq!(c.ft_balance_of(acc("p0.park.testnet")).0, 98_000);
    assert_eq!(c.last_settled_day(acc("p0.park.testnet"), PARK.into()), Some(3));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"settle\"")));
    conserved(&c);
}

#[test]
#[should_panic(expected = "already settled")]
fn a_day_can_never_be_paid_twice() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 3, vec![line("r1", 100)], "".into());
    c.settle_day(PARK.into(), 3, vec![line("r1", 100)], "".into());
}

#[test]
#[should_panic(expected = "already settled")]
fn days_must_move_forward() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 5, vec![line("r1", 100)], "".into());
    c.settle_day(PARK.into(), 4, vec![line("r1", 100)], "".into());
}

#[test]
fn patrons_settle_independently() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 3, vec![line("r1", 100)], "".into());
    ctx("p1.park.testnet", 0);
    c.settle_day(PARK.into(), 3, vec![line("r1", 100)], "".into());
    assert_eq!(c.get_park(PARK.into()).unwrap().balance.0, 200);
}

#[test]
#[should_panic(expected = "daily cap")]
fn the_daily_cap_is_enforced_on_chain() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 30_000), line("r2", 20_001)], "".into());
}

#[test]
#[should_panic(expected = "budget is too low")]
fn a_patron_cannot_spend_more_than_it_holds() {
    let mut c = setup();
    ctx(ADMIN, 0);
    c.set_patron(acc("p0.park.testnet"), U128(MAX_DAY_CAP), true);
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 100_001)], "".into());
}

#[test]
#[should_panic(expected = "not a registered patron")]
fn strangers_cannot_settle() {
    let mut c = setup();
    ctx("mallory.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 1)], "".into());
}

#[test]
#[should_panic(expected = "paused")]
fn paused_patrons_cannot_settle() {
    let mut c = setup();
    ctx(ADMIN, 0);
    c.set_patron(acc("p0.park.testnet"), U128(50_000), false);
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 1)], "".into());
}

#[test]
#[should_panic(expected = "bad venue id")]
fn venue_ids_are_validated() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1|evil", 1)], "".into());
}

#[test]
fn owner_withdraws_escrow_and_can_spend_it() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 4000)], "".into());
    ctx("alice.testnet", 1);
    assert_eq!(c.withdraw(PARK.into(), Some(U128(1000))).0, 1000);
    assert_eq!(c.withdraw(PARK.into(), None).0, 3000);
    assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 4000);
    assert_eq!(c.get_park(PARK.into()).unwrap().balance.0, 0);
    // alice pays a patron back (patrons are known receivers)
    c.ft_transfer(acc("p1.park.testnet"), U128(500), None);
    assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 3500);
    conserved(&c);
}

#[test]
#[should_panic(expected = "only the owner can withdraw")]
fn only_the_owner_withdraws() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 4000)], "".into());
    ctx("mallory.testnet", 1);
    c.withdraw(PARK.into(), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_needs_one_yocto() {
    let mut c = setup();
    ctx("alice.testnet", 0);
    c.withdraw(PARK.into(), None);
}

#[test]
fn transfer_park_moves_ownership_and_escrow() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.settle_day(PARK.into(), 1, vec![line("r1", 700)], "".into());
    ctx("alice.testnet", 1);
    c.transfer_park(PARK.into(), acc("bob.testnet"));
    ctx("bob.testnet", 1);
    assert_eq!(c.withdraw(PARK.into(), None).0, 700);
    conserved(&c);
}

#[test]
#[should_panic(expected = "only the admin")]
fn only_the_admin_registers_parks() {
    // Nobody can front-run a park id the server is about to register.
    let mut c = setup();
    ctx("mallory.testnet", 0);
    c.register_park("zzzz9999zzzz9999".into(), "Mine now".into(), None);
}

#[test]
fn admin_registered_parks_belong_to_the_admin_until_claimed() {
    let mut c = setup();
    ctx("admin.testnet", 0);
    c.register_park("bobspark".into(), "Bob's".into(), None);
    assert_eq!(c.get_park("bobspark".into()).unwrap().owner, acc(ADMIN));
    assert_eq!(c.list_parks(None, None).len(), 2);
}

#[test]
#[should_panic(expected = "hasn't happened yet")]
fn days_cannot_run_ahead_of_real_time() {
    let mut c = setup();
    ctx_at("p0.park.testnet", 0, T0_MS + 60_000); // one minute after the park was registered
    c.settle_day(PARK.into(), 10, vec![line("r1", 1)], "".into());
}

#[test]
fn one_minute_allows_a_few_fast_days() {
    let mut c = setup();
    ctx_at("p0.park.testnet", 0, T0_MS + 60_000);
    c.settle_day(PARK.into(), 4, vec![line("r1", 1)], "".into()); // 60 s / 20 s + 2 slack
}

#[test]
#[should_panic(expected = "over this park's daily cap")]
fn the_park_day_cap_spans_all_patrons() {
    let mut c = setup();
    ctx(ADMIN, 0);
    for i in 0..8 { c.set_patron(acc(&format!("p{i}.park.testnet")), U128(MAX_DAY_CAP), true); }
    c.fund_patrons((0..8).map(|i| acc(&format!("p{i}.park.testnet"))).collect(), U128(1_000_000));
    // 8 patrons × 50,000–200,000 would exceed 500,000 for one park-day.
    for i in 0..8 {
        ctx(&format!("p{i}.park.testnet"), 0);
        c.settle_day(PARK.into(), 1, vec![line("r1", 90_000)], "".into());
    }
}

#[test]
#[should_panic(expected = "day_cap must be")]
fn patron_caps_are_bounded() {
    let mut c = setup();
    ctx(ADMIN, 0);
    c.set_patron(acc("p0.park.testnet"), U128(MAX_DAY_CAP + 1), true);
}

#[test]
#[should_panic(expected = "minting budget")]
fn minting_is_budgeted_per_day() {
    let mut c = setup();
    ctx(ADMIN, 0);
    c.fund_patrons(vec![acc("p0.park.testnet"), acc("p1.park.testnet")], U128(MINT_PER_EPOCH / 2));
}

#[test]
fn the_mint_budget_resets_the_next_day() {
    let mut c = setup();
    ctx(ADMIN, 0);
    c.fund_patrons(vec![acc("p0.park.testnet")], U128(MINT_PER_EPOCH - 200_000));
    ctx_at(ADMIN, 0, T0_MS + 25 * HOUR_MS);
    c.fund_patrons(vec![acc("p0.park.testnet")], U128(MINT_PER_EPOCH));
}

#[test]
#[should_panic(expected = "too old")]
fn the_ring_refuses_days_older_than_it_remembers() {
    let mut c = setup();
    ctx(ADMIN, 0);
    c.set_patron(acc("p1.park.testnet"), U128(50_000), true);
    for d in 10..18 { ctx("p0.park.testnet", 0); c.settle_day(PARK.into(), d, vec![line("r1", 1)], "".into()); }
    ctx("p1.park.testnet", 0);
    c.settle_day(PARK.into(), 9, vec![line("r1", 1)], "".into());
}

#[test]
fn migrates_v1_state() {
    ctx_at(ADMIN, 0, T0_MS);
    let mut parks: IterableMap<String, v1::Park> = IterableMap::new(b"p");
    parks.insert(PARK.into(), v1::Park { owner: acc("alice.testnet"), name: "Old".into(), balance: U128(700), earned: U128(900), settlements: 3, created_ms: T0_MS });
    parks.flush();
    let mut balances: LookupMap<AccountId, u128> = LookupMap::new(b"b");
    balances.insert(acc("p0.park.testnet"), 300);
    balances.flush();
    let old = v1::Contract {
        admin: acc(ADMIN), parks, patrons: LookupMap::new(b"a"), last_day: LookupMap::new(b"d"),
        venue_totals: LookupMap::new(b"v"), balances, owners: LookupMap::new(b"o"), total_supply: 1000,
    };
    env::state_write(&old);
    ctx_at("park.testnet", 0, T0_MS);
    let c = Contract::migrate();
    let p = c.get_park(PARK.into()).unwrap();
    assert_eq!((p.balance.0, p.earned.0, p.settlements), (700, 900, 3));
    assert_eq!(c.audit()["park_escrow"], "700");
    assert_eq!(c.ft_balance_of(acc("p0.park.testnet")).0, 300);
}

#[test]
#[should_panic(expected = "only the admin")]
fn only_the_admin_mints() {
    let mut c = setup();
    ctx("p0.park.testnet", 0);
    c.fund_patrons(vec![acc("p0.park.testnet")], U128(1));
}

#[test]
#[should_panic(expected = "receiver has no credits account here")]
fn transfers_to_unknown_accounts_are_refused() {
    let mut c = setup();
    ctx("p0.park.testnet", 1);
    c.ft_transfer(acc("random.testnet"), U128(1), None);
}

#[test]
fn metadata_and_supply() {
    let c = setup();
    assert_eq!(c.ft_total_supply().0, 200_000);
    assert_eq!(c.ft_metadata()["symbol"], "CR");
    assert_eq!(c.audit()["total_supply"], "200000");
}

#[test]
fn the_admin_assigns_an_unclaimed_park_and_the_player_withdraws() {
    let mut c = setup();
    ctx("admin.testnet", 0);
    c.register_park("claimme01".into(), "Claim Me".into(), None);
    ctx("p0.park.testnet", 0);
    c.settle_day("claimme01".into(), 1, vec![line("r1", 500)], "".into());
    ctx("admin.testnet", 0);
    c.assign_park("claimme01".into(), acc("carol.testnet"));
    assert_eq!(c.get_park("claimme01".into()).unwrap().owner, acc("carol.testnet"));
    ctx("carol.testnet", 1);
    assert_eq!(c.withdraw("claimme01".into(), None).0, 500);
    conserved(&c);
}

#[test]
#[should_panic(expected = "already been claimed")]
fn a_claimed_park_cannot_be_reassigned_by_the_admin() {
    let mut c = setup();
    ctx("admin.testnet", 0);
    c.register_park("claimme02".into(), "Claim Me".into(), None);
    c.assign_park("claimme02".into(), acc("carol.testnet"));
    c.assign_park("claimme02".into(), acc("mallory.testnet"));
}

#[test]
#[should_panic(expected = "only the admin")]
fn only_the_admin_assigns_parks() {
    let mut c = setup();
    ctx("admin.testnet", 0);
    c.register_park("claimme03".into(), "Claim Me".into(), None);
    ctx("mallory.testnet", 0);
    c.assign_park("claimme03".into(), acc("mallory.testnet"));
}
