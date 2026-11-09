# Parkwright — design

Status: v0.1 (2026-11-07). This file is the source of truth; code that disagrees with it is a bug in one of the two.

## 1. What it is

Parkwright is an original theme-park builder that runs in the browser (three.js). You lay paths, place flat rides and stalls, build coasters piece by piece, set prices and hire staff. A crowd of simulated visitors walks the paths, gets hungry, tired, queasy and bored, and spends money only when a ride or a burger seems worth it.

Three things set it apart:

1. **Visitors are agents with wallets.** Visitors arrive in tour groups. Each group is backed by a NEAR testnet "patron" account that holds a budget, has a function-call key limited to one contract, and has a per-day spending cap the contract enforces. At the end of each park day, the day's spending settles onchain: from the patrons to the park's venues, which the park owner can withdraw from.
2. **The park terminal.** Every action in the game is also a command (`pw ride build carousel --at 12,8`). You can play from the in-game terminal, an AI park manager can play there (on private TEE inference, NEAR AI Cloud), or Claude Code can play over MCP. The camera follows whatever the command touched.
3. **Moddable.** Ride types, stall items, scenery and objectives are data, loaded from mod packs. Mods can also hook actions (query/execute) from a sandboxed worker.

It is not a port or remake of any existing game: no names, art, code or levels from one. The mechanics belong to the genre (needs, queues, price sensitivity, ratings) and are tuned with our own numbers.

## 2. Principles

- **The simulation is deterministic and headless.** `packages/sim` takes a seed and a list of actions and always produces the same park. It runs in the browser for play, on the server for verification and settlement, and in tests.
- **Rules decide, models talk.** An LLM never decides prices, accepts actions or moves money. The AI manager only issues the same commands a player can, and those go through `Query` validation like any other.
- **Players never notice the chain.** Settlement is periodic and batched, a few transactions per park day. Guests do not cause one transaction each.
- **Real P&L.** Venue revenue sits in contract balances that the owner can withdraw (unlike sending it to keyless addresses).
- **Privacy by default.** Onchain data is per-day venue totals, not per-visitor trails. The AI manager's prompts (your park's books) go only to TEE-attested models, and each reply carries a signature you can verify.

## 3. Time and units

- The simulation runs at 20 ticks per second at 1× speed (speeds 0, 1×, 2×, 4×).
- A day is 1800 ticks (90 s at 1×). A week is 7 days and a season is 4 weeks (28 days). There are no years, only seasons 1, 2, 3, and so on.
- Money is integer **cents** of park credits ("cr"). Ratings are integers ×100 (6.50 → 650). Visitor stats are 0–255.
- RNG: a single seeded xoshiro128** per park, held in sim state. Nothing in the simulation calls `Math.random`.

## 4. Visitors

Stats: `happy`, `energy`, `hunger` (255 = full), `thirst` (255 = quenched), `bladder` (0 = empty), `queasy`, `cash`, thrill window `[thrillMin, thrillMax]` (0–10 intensity), `stomach` (queasy tolerance 0–3).

- **Spawn:** happy 120–140, energy 110–130, hunger and thirst 180–220, cash `scenario.startCash ± 25%`. The thrill window is drawn from three archetypes: gentle (0–4), mixed (2–7), thrill seeker (5–10). The archetype mix is a scenario parameter.
- **Needs drift**, evaluated every 32 ticks:
  - hunger −1 and thirst −1 (−2 when hot);
  - bladder +1 when the visitor recently drank;
  - energy drifts toward a target;
  - happy drifts toward 128 by 1;
  - queasy decays by 2.
- **Thoughts** (a ring of 5, each with a 2-day lifetime): hungry (≤ 40), thirsty (≤ 50), need toilet (≥ 170), tired (energy ≤ 60), queasy (≥ 150), bad value, too crowded, dirty, lost, great ride. Need thoughts set a goal of the nearest matching venue.
- **Choosing a ride:** candidates are open rides reachable within a search budget. The visitor scores each one: `score = excitement − |intensity − preferred| − queuePenalty + novelty`. The best candidate that passes `wouldRide` becomes the goal.
- **`wouldRide` gates:**
  - the ride is open;
  - the queue is not full;
  - the visitor can afford it;
  - intensity is within the thrill window, widened by `happy/64`;
  - nausea is no more than `stomachCap[stomach] + happy/32`;
  - the price is no more than `2 × perceivedValue`.
  - `perceivedValue` is halved if the visitor paid more than 0 at the gate. That is the entry-fee-versus-ride-price tradeoff.
- **After a ride:** satisfaction = value term + thrill-fit term + queue term + familiarity. It moves `happy` and `queasy` and goes into the ride's satisfaction and popularity samples.
- **Shops:** an item is bought if the need is present and `price − value ≤ tolerance(happy)`. A good deal gives a happiness bonus.
- **Leaving:** a visitor heads for the exit when energy < 40, happy < 50, or cash can't buy anything. They also leave when lost for too long.
- **Environment:** litter and vomit on nearby path tiles, crowding (≥ 8 visitors on a tile), benches, scenery density and bins all nudge `happy`.

Visitors only make decisions at path junctions. With a goal, they run a bounded A* over the path graph, then cache the route until something changes. Without a goal, they wander and prefer to keep going straight.

## 5. Rides

A **ride type** is data:
- footprint;
- capacity and cycle time;
- build cost;
- base ratings (E, I, N);
- rating modifiers;
- upkeep;
- reliability profile;
- a model id.

The base pack ships 6 flat rides (carousel, swing tower, drop tower, teacups, ferris wheel, haunted walk), plus 1 coaster family with a track kit.

- **Ratings:** flat rides are rated when built, from base ratings plus scenery and shelter modifiers. Coasters are rated after a test run, from simulated stats: max speed, average speed, max positive, negative and lateral G, drops, total drop height, airtime, length and duration. Each stat has a weight in the ride type. Intensity above 9 cuts excitement (−20% per step). Missing requirements (for example, a coaster with no drop of at least 8 m) halve the ratings.
- **Value:** `value = (E·we + I·wi + N·wn) >> k`. It decays with ride age in seasons, and duplicate ride types in the same park reduce it.
- **Reliability:**
  - drops a little every day;
  - each day there is a chance of a breakdown that grows as reliability falls;
  - mechanics on an inspection schedule restore it;
  - a broken ride ejects its queue and creates "broken" thoughts.
- **Queues** are path tiles of type `queue` that link an entrance to the end of the line. Long waits reduce happiness. Queue-time samples feed the ride panel.

### Coaster builder

- **Track pieces**, all on the tile grid:
  - station;
  - straight;
  - left and right 90° curves (radius 1 or 2);
  - slopes up and down (gentle and steep) and their transitions;
  - lift;
  - brakes;
  - chain-free drop.
- Each piece declares an entry pose, an exit pose (tile, height, heading, pitch), a spline and its tile occupancy.
- **Building:** the builder snaps the next piece to the open end. The circuit closes when the end pose matches the station's entry pose.
- **Test run:** a 1-D point-mass simulation along the spline, with gravity, rolling friction and air drag. The lift pulls at a fixed speed and brakes clamp speed. The run records G-forces from curvature. A train that stalls before closing the loop fails the test.
- The track mesh is generated from the spline (rails, ties, supports to the ground). It is not a stored model.

## 6. Economy (in-game)

- **Starting money:** 15,000 cr, plus a 10,000 cr loan (up to 25,000 cr) at 8% per season, charged weekly.
- **Income:** gate fee, ride tickets, stall sales.
- **Costs:**
  - construction;
  - upkeep (weekly);
  - stall stock;
  - wages (weekly; handyman 400 cr per season, mechanic 650, guard 500, entertainer 450);
  - marketing;
  - interest.
- The ledger keeps per-category totals for every week and season, which drive the finance panel and the `pw finance` command.
- **Park rating (0–1000):** recomputed daily from:
  - the share of happy visitors;
  - visitor count;
  - average uptime;
  - total excitement and intensity balance;
  - litter;
  - recent incidents.
- **Visitor arrival rate:** rises with park rating and the value of the rides on offer. It falls when the gate fee is higher than that value. Marketing campaigns add arrivals.
- **Objectives** (data, from the scenario):
  - reach N visitors with rating ≥ R by season S;
  - park value ≥ X;
  - monthly ride income ≥ X;
  - build K coasters with E ≥ 6.

### 6.1 Rules versions

Published parks are verified by replaying their action log, so a rule change must never change how an existing park plays out. `ParkState.rules` names the rules a park runs on. New parks start on the latest version; saves without the field are v1 and replay exactly as they always did. Every behavioural change is gated on the park's own version, the server replays each save on its own version, and frozen v1 action logs in `packages/sim/test/fixtures` must keep reproducing their recorded state hash.

- **v1:** the original rules, tuned for about 100–400 visitors.
- **v2 (balance pass for 500–1,500 visitors):**
  - arrivals scale with the draw of the open rides (×(1 + draw/40)) and build up by word of mouth (from 1/6 of demand to full after 5,000 visitors); a park slows arrivals at 3.5× its draw and fills at 5×;
  - flat rides cycle in 60% of the time and dispatch a partial load after 60 ticks instead of 120; 20 can wait at an entrance before queue tiles;
  - visitors skip rides whose queue is full, weigh a queue by how full it is, and care half as much about intensity, so a crowd spreads over the rides; a path tile takes 12 before it feels crowded;
  - litter goes in any bin within 2 tiles; handymen look up to 8 path tiles out for litter; the rating counts litter per path tile and forgives a few lost visitors per 50 in the park;
  - wages ×4 and upkeep ×3, so running costs keep pace with a big park's takings.
- `pnpm --filter @parkwright/sim balance` builds reference parks with `pw` commands and prints visitors, rating, cash, income, spend and ms per simulated day; `--stress 500,1000,1500` times a day at a fixed crowd size.

## 7. Actions (the moddable core)

Every change to the game is an `Action`: `{ type, params, actor, tick }`, handled in two steps:
- `query(state, params) → { ok, cost, error?, hint? }`, which is pure;
- `execute(state, params) → Result`, which changes the state.

The action runner:
1. checks the actor's permissions (player, AI manager, or mod);
2. runs `query`, plus an automatic affordability check;
3. runs mod query hooks, which may veto or adjust the action;
4. runs `execute`;
5. runs mod execute hooks;
6. books the cost to the ledger;
7. emits an event.

Errors are guided: a refusal says what would be valid ("no path at 12,8; nearest path tile 11,8"). Results carry a `focus` (tile, entity) so the camera can follow.

- **Save game** = the scenario + the seed + the action log, plus periodic snapshots (every in-game day) so loading is fast. Replaying the log from the last snapshot must reproduce the state hash; this is tested.
- **Mods:**
  - a manifest (`mod.json`) declaring ride types, items, scenery, scenarios, and an optional `hooks.js`;
  - hooks run in a Web Worker (browser) or `node:vm` with a time budget (server), and see a read-only state view;
  - a hook can return `veto`, or adjust `cost`;
  - mods are content-hashed, and a save records the mod hashes it needs.

## 8. The terminal

- **`pw`** is a resource/verb CLI shared by every interface: `pw park`, `pw map`, `pw ride list|build|price|open|close|inspect`, `pw coaster start|add|undo|test`, `pw shop`, `pw path`, `pw staff`, `pw finance`, `pw visitors thoughts`, `pw marketing`, `pw loan`. It is text-first, uses display names rather than ids, has guided errors, and offers `-o json`.
- **In game:** an xterm.js panel (toggle with \`), with the same parser. `pw ask "<goal>"` hands the turn to the AI manager.
- **AI manager:** a NEAR AI Cloud model in a TEE (attested), driven by a tool loop whose only tool is `pw`. It has a budget per day, set by the player. Every prompt and reply is signed, and you can check its proof bundle with `pnpm verify:manager`.
- **Claude Code over MCP:** the server exposes MCP over Streamable HTTP at `/mcp/<code>` (stateless; tools `pw` and `park_overview`).
  - `bridge` in the game opens a WebSocket (`/ws/bridge`). The server pairs it with a 26-char base32 code (~128 bits, the only credential), valid while the tab is open.
  - Commands go MCP → relay → the tab, run there with `runCommand`, and the result comes back.
  - The relay is in-process locally. Hosted, it uses Redis pub/sub (commands) plus a reply list read with `BRPOP`, because the MCP request and the socket may land on different replicas.
  - Rate limit: 90 commands per minute per code.

**As built (2026-11):**
- `POST /api/ai/manager` relays a turn to NEAR AI (JSON mode): `{say, commands ≤5, done}` plus the proof bundle. The browser runs the commands against its own park and feeds the results back, up to 8 turns, stopping at the player's `--budget`.
- `GET /api/ai/attestation` returns the signing keys from the model's attestation report.
- Limits: 12 manager and 4 mod calls per minute per client, and a server-wide daily cap (`AI_DAILY_CALLS`, default 400), because NEAR AI credits are finite.

### 8.1 The modding terminal

The terminal can also make mods. You describe what you want, an AI writes the mod pack, and the game checks it before anything loads.

- **Commands:**
  - `pw mod list | show <id> | validate <id> | enable <id> | disable <id> | export <id>`
  - `pw mod ai "<request>"`, e.g. `pw mod ai "a spooky drop tower that sells hot cocoa at night"`. The assistant returns a draft pack and a diff.
  - `pw mod apply` loads the draft; `pw mod discard` drops it.
- **AI backends:**
  - **NEAR AI** (default, and the only one hosted): a TEE-attested model on NEAR AI Cloud. The request and your park's data stay private, and each reply is signed (see the AI manager above).
  - **Claude terminal** (local only, as built): the server, started with `PW_CLAUDE_TERMINAL=1`, spawns the real `claude` CLI and streams it to the in-game xterm over `/ws/claude`. The terminal comes from `apps/server/pty-helper.py`, a Python pty, because BSD `script` needs a TTY on stdin.
    - The socket must come from loopback, with a localhost Host (DNS rebinding) and a same-origin page.
    - Claude runs with `--strict-mcp-config` against this tab's bridge (`pw`, `park_overview`, `mod_apply`), with `--allowedTools` limited to those plus file tools and `--disallowedTools Bash WebFetch WebSearch`.
    - One session per server. It is never enabled in the hosted image.
    - It runs in `mods/workspace/`, with the parkwright MCP server attached and `--allowedTools` limited to `mcp__parkwright__*` plus Read/Write/Edit inside that folder.
    - No `--dangerously-skip-permissions`, and no shell.
    - It is never enabled on the hosted server.
- **What AI mods may contain:** data only, meaning ride types, items, scenery and scenarios, all checked against the content schema with sane bounds. Ratings, costs and capacities are clamped.
  - Behaviour changes use **declarative rules**, not code. For example, `{ "on": "ride.build", "when": { "type": "teacups" }, "cost": "×0.5" }` or `{ "on": "ride.build", "when": { "kind": "stall" }, "veto": "stalls are banned in this scenario" }`. The sim turns these into query hooks.
  - Hand-written local mods may also ship `hooks.js`, which runs in a Worker sandbox. AI output is never run as code.
- **As built:** `validateMod` (content package) whitelists fields, clamps every number, namespaces ids as `mod-<name>--<id>` (a mod can never replace base content), checks item references, and keeps only rules of the form veto or cost ×0.1–5. `rulesToHooks` (sim) turns rules into query hooks. Mods are saved in `localStorage` and inside every save file, and re-validated on every load, including by the server for published parks.
- **Assets:** a mod can name a model id. If no `.glb` exists, the client uses the procedural mesh tinted with the mod's colour. On a local install, the Claude terminal can also write a Blender script into `assets/blender/mods/` for `pnpm assets` to build.
- **Persistence:** mods are stored by content hash (Cosmos DB hosted, `mods/` locally). Saves list the hashes they need, and a save won't load with a different version of a mod.

## 9. NEAR (testnet)

Contract `park.parkwright.testnet` (`contracts/park`, Rust, near-sdk 5.29), with admin `parkwright.testnet`.

- **Credits:** an NEP-141 token, symbol `CR`, 2 decimals. 1 credit = 100 units = 100 in-game cents. It implements `ft_transfer`, `ft_balance_of`, `ft_total_supply` and `ft_metadata`. Transfers only go to accounts that already hold credits, own a park, or are patrons; that keeps storage bounded without storage deposits.
- **Parks:** `register_park(park_id, name, owner?)` is admin-only, so nobody can front-run a park id or spam storage. The server registers each cloud park on its first publish, owned by the admin until a player claims it with `transfer_park`. A park holds what visitors spend in escrow, and its owner calls `withdraw` to move it to their credit balance.
- **Patrons** (agent visitors): `p0`–`p7.parkwright.testnet`, one per visitor group in the sim.
  - Each patron's only key is a function-call key for `settle_day` on the contract. It has no full-access key, so it can't move NEAR or call anything else.
  - The admin sets each patron's `day_cap` (1,000 CR per park-day) and mints its budget (`fund_patrons`, 20,000 CR, topped up automatically below 5,000 CR).
- **Settlement:** `settle_day(park_id, day, lines[{venue, amount}], state_hash)` is signed by the patron itself. The contract:
  - requires `day` > the last day this patron settled for this park, so a day can't be paid twice and retries are safe;
  - requires the sum ≤ `day_cap` (at most 2,000 CR) and ≤ the patron's balance;
  - requires the park's total for that day, across all patrons, ≤ 5,000 CR. A fixed ring of the last 8 park-days per park keeps this bounded;
  - refuses days ahead of real time: `day ≤ (now − created) / 20 s + 2`;
  - moves the credits into the park's escrow and emits a `parkwright/settle` event (the lines are in the event; nothing per-venue is stored).
- **Minting:** `fund_patrons` mints at most 200,000 CR per 24 h. Even a leaked server key can only create a bounded amount per day, and only patrons can spend it, within caps, into admin-registered parks.
  - `state_hash` is a sha256 of that day's stats, so the claim can be audited.
- **The game server's admin key** is a function-call key on `parkwright.testnet`, limited to `register_park`, `set_patron` and `fund_patrons`.
- **Invariant:** credits in accounts plus park escrow always equal `ft_total_supply`. The contract tests check this. `audit` reports supply, escrow and today's minting in O(1).
- **Upgrades:** `migrate()` (private, `#[init(ignore_state)]`) converts the v1 state, and `cargo near deploy … with-init-call migrate` runs it.
- **Worker:** `apps/server/src/settle.ts`. After each cloud save, the park is marked dirty. One replica at a time (holding a Redis lock) settles its finished days: one `settle_day` per visitor group per day.
  - If a day's total is over the cap, the agent pays at most the cap, scaled evenly across venues.
  - "Already settled" counts as success.
- **Verified settlement:** a published save carries its complete action log (`fullLog`). Before any settlement, and before ranking, the server replays it in a worker thread from seed, scenario, mods and actions, and requires the exact same state hash (`apps/server/src/verify.ts`). This is cached per park version.
  - Inflated spend, dropped or reordered actions, and trimmed logs all fail.
  - Parks that load cost-changing mod rules partway through also fail, conservatively.
  - The caps stay as a second line of defence.
- **Keys:** settle_day burns ~3 Tgas (measured). The first patrons' keys have a lifetime allowance of 0.12 NEAR, roughly 400 settlements each. New patrons get keys with no allowance, limited by the account's own 0.3 NEAR. A function-call-only account can't be rekeyed, so the fix is new patron accounts plus `set_patron(old, active=false)`.
- **Later:** contractor agents that bid to build coasters, paid from escrow; players claiming parks with NEAR Auth.

## 10. Architecture

```
apps/web        three.js client: renderer, build tools, HUD, terminal (xterm.js)
apps/server     Node API: parks, saves, settlement outbox, AI manager loop, NEAR events
packages/sim    deterministic simulation + actions + pw command parser (no DOM)
packages/content base mod pack: ride types, items, scenery, scenarios (JSON)
packages/ai     NEAR AI Cloud client, signature/attestation checks
packages/mcp    MCP server exposing `pw`
contracts/park  NEAR contract
assets/blender  Blender Python scripts → glTF (.glb) in apps/web/public/models
```

**Storage and caching:**
- Saves (snapshots + action logs) live in Azure Cosmos DB (NoSQL, serverless). The partition key is `parkId`.
- Local development uses a file store behind the same interface.
- Azure Managed Redis caches park snapshots (read-through), leaderboards (sorted sets), NEAR view calls (30 s TTL), and rate limits. It also holds locks for the settlement and agent loops.
- An in-process LRU sits in front of Redis.
- Static assets are content-hashed and served with `immutable` cache headers. Models are compressed with meshopt/Draco.

**Settlement outbox:** each simulated day appends one record per patron to an outbox in Cosmos DB. A worker drains it and uses the Redis lock so only one replica settles at a time. Delivery is at-least-once; a record that has already settled is rejected by the contract's day check, and the worker accepts that rejection as success.

**Deploy:** Azure Container Apps (one image for web + server), Azure Container Registry, managed identity to Cosmos and Redis. GitHub Actions CI:
- typecheck, test and build on every PR;
- contract tests;
- a CD job on merge to `main` that builds in ACR and rolls the app, using OIDC federated credentials with no stored secrets.

## 11. Assets

The models aim for a detailed miniature: bevelled, smooth-shaded parts in a small shared material set (painted metal, chrome, brass, wood, canvas, stone, glass, emissive bulbs). At export the parts under each animated node are joined per material, so a ride is a handful of draw calls; scenery is one file of props drawn with instancing. Each model is a function in `assets/blender/models.py`. Running `pnpm assets` executes `blender -b -P` and exports `.glb` with origin at the tile centre, Y-up, 1 unit = 1 m, and tile = 4 m. The generated `.glb` files are committed, so CI and players never need Blender. Every model has a procedural fallback in the client.

## 12. Build order

1. Sim core: state, RNG, clock, actions, ledger, paths, flat rides, stalls, visitors. Tests and replay hash.
2. Web client: map, camera, path and ride placement, visitors, HUD.
3. Terminal and the `pw` CLI.
4. Coasters: pieces, builder, test-run physics, ratings, mesh.
5. Server: saves and caching (file/Redis/Cosmos).
6. Contract: parks, venues, patrons, `settle_day`; the outbox worker.
7. AI manager (NEAR AI TEE) and MCP.
8. Mods: loader and hooks.
9. Blender assets.
10. Azure infrastructure and CD.
