use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(caller: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(1_700_000_000_000_000_000)
        .build());
}

const ADMIN: &str = "admin.testnet";
const PARK: &str = "abcd1234abcd1234";

fn setup() -> Contract {
    ctx(ADMIN, 0);
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
    let held = ["p0.park.testnet", "p1.park.testnet", "alice.testnet", "bob.testnet"].iter().map(|a| c.balance(&acc(a))).sum::<u128>();
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
    assert_eq!(c.venue_total(PARK.into(), "r12".into()).0, 1500);
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
    c.set_patron(acc("p0.park.testnet"), U128(1_000_000), true);
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
#[should_panic(expected = "you can only register parks you own")]
fn only_the_admin_registers_for_others() {
    let mut c = setup();
    ctx("mallory.testnet", 0);
    c.register_park("zzzz9999zzzz9999".into(), "Not yours".into(), Some(acc("alice.testnet")));
}

#[test]
fn players_can_register_their_own_parks() {
    let mut c = setup();
    ctx("bob.testnet", 0);
    c.register_park("bobspark".into(), "Bob's".into(), None);
    assert_eq!(c.get_park("bobspark".into()).unwrap().owner, acc("bob.testnet"));
    assert_eq!(c.list_parks(None, None).len(), 2);
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
