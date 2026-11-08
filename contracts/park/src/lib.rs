//! Parkwright park contract.
//!
//! - **Credits** are an NEP-141 token (symbol CR, 2 decimals: 1 credit = 100 units = 100 in-game cents).
//! - **Patrons** are agent accounts (one per visitor group). Each holds a credit budget and has a daily
//!   cap (at most MAX_DAY_CAP). A patron signs its own `settle_day` with a function-call key that can do
//!   nothing else.
//! - **Parks** are registered by the admin (the game server) and hold what visitors spent in escrow;
//!   the owner withdraws it.
//! - **Settlement** is idempotent per (patron, park, day), bounded per park-day across all patrons
//!   (PARK_DAY_CAP), and a park's days can't run ahead of real time.
//! - **Minting** patron budgets is limited to MINT_PER_EPOCH per 24 hours, so even a leaked admin key
//!   can only create a bounded amount of credits per day.
//!
//! The game's rules (who rides what, what it costs) live in the simulation, not here. This contract
//! only moves money, within limits it enforces itself.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{AccountId, NearToken, PanicOnDefault, env, near, require};

const MAX_LINES: usize = 40;
const MAX_VENUE_LEN: usize = 24;
const MAX_NAME_LEN: usize = 40;
const MAX_HASH_LEN: usize = 64;
/** Most a patron may be allowed per park-day (set_patron can't go higher). 2,000 CR. */
pub const MAX_DAY_CAP: u128 = 200_000;
/** Most all patrons together may settle into one park for one day. 5,000 CR. */
pub const PARK_DAY_CAP: u128 = 500_000;
/** Most credits fund_patrons may mint per 24 h epoch. 200,000 CR. */
pub const MINT_PER_EPOCH: u128 = 20_000_000;
const EPOCH_MS: u64 = 86_400_000;
/** A park day takes at least this long in real time (90 s at 1×, so this allows up to 4.5×). */
pub const GAME_DAY_MIN_MS: u64 = 20_000;
const DAY_SLACK: u64 = 2;
/** Recent park-days kept per park for the park-day cap (fixed size: storage stays bounded). */
const RING: usize = 8;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Park {
    pub owner: AccountId,
    pub name: String,
    /// Credits in escrow, waiting for the owner to withdraw.
    pub balance: U128,
    /// All credits ever settled into this park.
    pub earned: U128,
    pub settlements: u32,
    pub created_ms: u64,
    /// (day, total settled that day) for the most recent park-days.
    pub recent_days: Vec<(u32, U128)>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Patron {
    /// Most credits this patron may settle into one park for one day.
    pub day_cap: U128,
    /// All credits this patron has ever settled.
    pub spent: U128,
    pub active: bool,
}

#[near(serializers = [json])]
pub struct SettleLine {
    /// Venue id inside the park (e.g. "r12" for ride 12, "gate").
    pub venue: String,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct PatronView {
    pub account: AccountId,
    pub balance: U128,
    pub day_cap: U128,
    pub spent: U128,
    pub active: bool,
}

#[near(serializers = [json])]
pub struct ParkView {
    pub id: String,
    #[serde(flatten)]
    pub park: Park,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    admin: AccountId,
    parks: IterableMap<String, Park>,
    patrons: LookupMap<AccountId, Patron>,
    /// "patron|park" → last settled day.
    last_day: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
    /// How many parks each account owns (so membership checks are O(1)).
    owners: LookupMap<AccountId, u32>,
    total_supply: u128,
    /// Credits held in park escrow (so audit is O(1)).
    escrow_total: u128,
    mint_epoch: u64,
    minted_in_epoch: u128,
}

fn emit(event: &str, data: serde_json::Value) {
    let log = json!({ "standard": "parkwright", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn emit_nep141(event: &str, data: serde_json::Value) {
    let log = json!({ "standard": "nep141", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn valid_park_id(id: &str) -> bool {
    (8..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn valid_venue(v: &str) -> bool {
    !v.is_empty() && v.len() <= MAX_VENUE_LEN && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[near]
impl Contract {
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self {
            admin,
            parks: IterableMap::new(b"q"),
            patrons: LookupMap::new(b"a"),
            last_day: LookupMap::new(b"d"),
            balances: LookupMap::new(b"b"),
            owners: LookupMap::new(b"o"),
            total_supply: 0,
            escrow_total: 0,
            mint_epoch: 0,
            minted_in_epoch: 0,
        }
    }

    fn assert_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the admin can do this");
    }

    fn add_owner(&mut self, a: &AccountId, delta: i32) {
        let n = self.owners.get(a).copied().unwrap_or(0) as i64 + delta as i64;
        if n <= 0 { self.owners.remove(a); } else { self.owners.insert(a.clone(), n as u32); }
    }

    fn balance(&self, a: &AccountId) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }

    // ---------------- parks ----------------

    /// Register a park (admin only: the game server registers each cloud park, owned by the admin
    /// until a player claims it via transfer_park). Admin-only so nobody can front-run a park id,
    /// and so the contract's storage can't be spammed.
    pub fn register_park(&mut self, park_id: String, name: String, owner: Option<AccountId>) {
        self.assert_admin();
        require!(valid_park_id(&park_id), "park_id must be 8–32 lowercase letters or digits");
        require!(!name.trim().is_empty() && name.len() <= MAX_NAME_LEN, "name must be 1–40 characters");
        require!(self.parks.get(&park_id).is_none(), "that park is already registered");
        let owner = owner.unwrap_or_else(|| self.admin.clone());
        self.parks.insert(
            park_id.clone(),
            Park { owner: owner.clone(), name: name.clone(), balance: U128(0), earned: U128(0), settlements: 0, created_ms: env::block_timestamp_ms(), recent_days: vec![] },
        );
        self.add_owner(&owner, 1);
        emit("park_registered", json!({ "park_id": park_id, "owner": owner, "name": name }));
    }

    /// Hand a park (and its unwithdrawn escrow) to another account.
    #[payable]
    pub fn transfer_park(&mut self, park_id: String, new_owner: AccountId) {
        near_sdk::assert_one_yocto();
        let mut park = self.parks.get(&park_id).cloned().unwrap_or_else(|| env::panic_str("no such park"));
        require!(park.owner == env::predecessor_account_id(), "only the owner can transfer a park");
        let old = park.owner.clone();
        park.owner = new_owner.clone();
        self.parks.insert(park_id.clone(), park);
        self.add_owner(&old, -1);
        self.add_owner(&new_owner, 1);
        emit("park_transferred", json!({ "park_id": park_id, "from": old, "to": new_owner }));
    }

    /// Move escrowed credits to the owner's credit balance (all of it if no amount).
    #[payable]
    pub fn withdraw(&mut self, park_id: String, amount: Option<U128>) -> U128 {
        near_sdk::assert_one_yocto();
        let mut park = self.parks.get(&park_id).cloned().unwrap_or_else(|| env::panic_str("no such park"));
        require!(park.owner == env::predecessor_account_id(), "only the owner can withdraw");
        let amt = amount.map(|a| a.0).unwrap_or(park.balance.0);
        require!(amt > 0, "nothing to withdraw");
        require!(amt <= park.balance.0, "that is more than the park holds");
        park.balance = U128(park.balance.0 - amt);
        self.escrow_total -= amt;
        let owner = park.owner.clone();
        self.parks.insert(park_id.clone(), park);
        let b = self.balance(&owner);
        self.balances.insert(owner.clone(), b + amt);
        emit("withdraw", json!({ "park_id": park_id, "owner": owner, "amount": U128(amt) }));
        U128(amt)
    }

    // ---------------- patrons ----------------

    /// Admin: register or update a patron agent and its daily cap.
    pub fn set_patron(&mut self, patron: AccountId, day_cap: U128, active: bool) {
        self.assert_admin();
        require!(day_cap.0 > 0 && day_cap.0 <= MAX_DAY_CAP, "day_cap must be 1–200000 (2,000 CR)");
        let spent = self.patrons.get(&patron).map(|p| p.spent).unwrap_or(U128(0));
        self.patrons.insert(patron.clone(), Patron { day_cap, spent, active });
        emit("patron_set", json!({ "patron": patron, "day_cap": day_cap, "active": active }));
    }

    /// Admin: mint credits into patron budgets (visitors arriving with money).
    pub fn fund_patrons(&mut self, patrons: Vec<AccountId>, amount: U128) {
        self.assert_admin();
        require!(!patrons.is_empty() && patrons.len() <= 50, "fund 1–50 patrons at a time");
        require!(amount.0 > 0, "amount must be positive");
        let epoch = env::block_timestamp_ms() / EPOCH_MS;
        if epoch != self.mint_epoch { self.mint_epoch = epoch; self.minted_in_epoch = 0; }
        let total = amount.0.checked_mul(patrons.len() as u128).unwrap_or_else(|| env::panic_str("overflow"));
        require!(self.minted_in_epoch + total <= MINT_PER_EPOCH, "over today's minting budget");
        self.minted_in_epoch += total;
        for p in patrons {
            require!(self.patrons.get(&p).is_some(), "not a registered patron");
            let b = self.balance(&p);
            self.balances.insert(p.clone(), b + amount.0);
            self.total_supply += amount.0;
            emit_nep141("ft_mint", json!({ "owner_id": p, "amount": amount, "memo": "patron budget" }));
        }
    }

    /// A patron pays what its visitors spent in a park on one day. Signed by the patron itself.
    /// Rejected if the day was already settled, if it exceeds the patron's daily cap or balance,
    /// or if the park doesn't exist. `state_hash` commits to the simulation state for audit.
    pub fn settle_day(&mut self, park_id: String, day: u32, lines: Vec<SettleLine>, state_hash: String) -> U128 {
        let patron_id = env::predecessor_account_id();
        let patron = self.patrons.get(&patron_id).cloned().unwrap_or_else(|| env::panic_str("not a registered patron"));
        require!(patron.active, "this patron is paused");
        let mut park = self.parks.get(&park_id).cloned().unwrap_or_else(|| env::panic_str("no such park"));
        require!(!lines.is_empty() && lines.len() <= MAX_LINES, "1–40 lines per settlement");
        require!(state_hash.len() <= MAX_HASH_LEN, "state_hash too long");
        // A park's days can't run ahead of real time.
        let elapsed = env::block_timestamp_ms().saturating_sub(park.created_ms);
        require!((day as u64) <= elapsed / GAME_DAY_MIN_MS + DAY_SLACK, "that day hasn't happened yet");
        let key = format!("{patron_id}|{park_id}");
        if let Some(last) = self.last_day.get(&key) {
            require!(day > *last, "that day is already settled");
        }
        let mut sum: u128 = 0;
        for l in &lines {
            require!(valid_venue(&l.venue), "bad venue id");
            require!(l.amount.0 > 0, "line amounts must be positive");
            sum = sum.checked_add(l.amount.0).unwrap_or_else(|| env::panic_str("overflow"));
        }
        require!(sum <= patron.day_cap.0, "over this patron's daily cap");
        let bal = self.balance(&patron_id);
        require!(sum <= bal, "the patron's budget is too low");
        // Park-day cap across all patrons, tracked in a fixed-size ring of recent days.
        let slot = match park.recent_days.iter().position(|(d, _)| *d == day) {
            Some(i) => i,
            None => {
                if park.recent_days.len() >= RING {
                    let (oldest_i, oldest) = park.recent_days.iter().enumerate().min_by_key(|(_, (d, _))| *d).map(|(i, (d, _))| (i, *d)).unwrap();
                    require!(day > oldest, "that day is too old to settle now");
                    park.recent_days.remove(oldest_i);
                }
                park.recent_days.push((day, U128(0)));
                park.recent_days.len() - 1
            }
        };
        let day_total = park.recent_days[slot].1.0 + sum;
        require!(day_total <= PARK_DAY_CAP, "over this park's daily cap");
        park.recent_days[slot].1 = U128(day_total);

        self.balances.insert(patron_id.clone(), bal - sum);
        self.last_day.insert(key, day);
        park.balance = U128(park.balance.0 + sum);
        park.earned = U128(park.earned.0 + sum);
        park.settlements += 1;
        self.escrow_total += sum;
        self.parks.insert(park_id.clone(), park);
        self.patrons.insert(patron_id.clone(), Patron { spent: U128(patron.spent.0 + sum), ..patron });
        emit(
            "settle",
            json!({ "park_id": park_id, "patron": patron_id, "day": day, "amount": U128(sum), "lines": lines.len(), "state_hash": state_hash }),
        );
        U128(sum)
    }

    // ---------------- NEP-141 (core) ----------------

    /// Send credits. To keep storage bounded without storage deposits, the receiver must already
    /// hold credits, own a park, or be a patron.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "can't send to yourself");
        require!(amount.0 > 0, "amount must be positive");
        let known = self.balances.get(&receiver_id).is_some() || self.patrons.get(&receiver_id).is_some() || self.owners.get(&receiver_id).is_some();
        require!(known, "receiver has no credits account here");
        let sb = self.balance(&sender);
        require!(sb >= amount.0, "not enough credits");
        self.balances.insert(sender.clone(), sb - amount.0);
        let rb = self.balance(&receiver_id);
        self.balances.insert(receiver_id.clone(), rb + amount.0);
        emit_nep141("ft_transfer", json!({ "old_owner_id": sender, "new_owner_id": receiver_id, "amount": amount, "memo": memo }));
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_metadata(&self) -> serde_json::Value {
        json!({ "spec": "ft-1.0.0", "name": "Parkwright Credits", "symbol": "CR", "decimals": 2, "icon": null, "reference": null, "reference_hash": null })
    }

    // ---------------- views ----------------

    pub fn get_admin(&self) -> AccountId {
        self.admin.clone()
    }

    pub fn get_park(&self, park_id: String) -> Option<Park> {
        self.parks.get(&park_id).cloned()
    }

    pub fn list_parks(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ParkView> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(20).min(100) as usize;
        self.parks.iter().skip(from).take(limit).map(|(id, p)| ParkView { id: id.clone(), park: p.clone() }).collect()
    }

    pub fn get_patron(&self, account_id: AccountId) -> Option<PatronView> {
        self.patrons.get(&account_id).map(|p| PatronView {
            account: account_id.clone(),
            balance: U128(self.balance(&account_id)),
            day_cap: p.day_cap,
            spent: p.spent,
            active: p.active,
        })
    }

    pub fn last_settled_day(&self, patron: AccountId, park_id: String) -> Option<u32> {
        self.last_day.get(&format!("{patron}|{park_id}")).copied()
    }

    /// Supply, escrow and today's minting. Credits in accounts = total_supply − park_escrow.
    pub fn audit(&self) -> serde_json::Value {
        json!({
            "total_supply": U128(self.total_supply),
            "park_escrow": U128(self.escrow_total),
            "minted_today": U128(if env::block_timestamp_ms() / EPOCH_MS == self.mint_epoch { self.minted_in_epoch } else { 0 }),
            "mint_budget": U128(MINT_PER_EPOCH),
        })
    }

    /// Upgrade from v1 state: parks gain the recent-days ring (and move to a new map prefix),
    /// per-venue totals are dropped (events carry the lines), escrow and mint epoch are tracked.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: v1::Contract = env::state_read().unwrap_or_else(|| env::panic_str("no v1 state"));
        let mut parks: IterableMap<String, Park> = IterableMap::new(b"q");
        let mut escrow = 0u128;
        let mut old_parks = old.parks;
        for (id, p) in old_parks.iter() {
            escrow += p.balance.0;
            parks.insert(id.clone(), Park { owner: p.owner.clone(), name: p.name.clone(), balance: p.balance, earned: p.earned, settlements: p.settlements, created_ms: p.created_ms, recent_days: vec![] });
        }
        old_parks.clear();
        old_parks.flush();
        parks.flush();
        Self {
            admin: old.admin,
            parks,
            patrons: old.patrons,
            last_day: old.last_day,
            balances: old.balances,
            owners: old.owners,
            total_supply: old.total_supply,
            escrow_total: escrow,
            mint_epoch: 0,
            minted_in_epoch: 0,
        }
    }
}

mod v1 {
    use super::*;
    #[near(serializers = [borsh])]
    pub struct Park {
        pub owner: AccountId,
        pub name: String,
        pub balance: U128,
        pub earned: U128,
        pub settlements: u32,
        pub created_ms: u64,
    }
    #[near(serializers = [borsh])]
    pub struct Contract {
        pub admin: AccountId,
        pub parks: IterableMap<String, Park>,
        pub patrons: LookupMap<AccountId, super::Patron>,
        pub last_day: LookupMap<String, u32>,
        pub venue_totals: LookupMap<String, u128>,
        pub balances: LookupMap<AccountId, u128>,
        pub owners: LookupMap<AccountId, u32>,
        pub total_supply: u128,
    }
}

/// One NEAR yocto, for tests and docs.
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[cfg(test)]
mod tests;
