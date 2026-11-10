# Parkwright

An original theme-park builder in three.js. You build paths, flat rides, coasters and stalls, and simulated guests decide whether your park is worth their money. Guests are agents with NEAR testnet wallets and spending caps. The park manager can be you, typing in the in-game terminal, or an AI running on private (TEE) inference.

Work in progress. See DESIGN.md.

## Play

- Hosted (testnet demo): https://parkwright.whitemeadow-d4da3d5d.northeurope.azurecontainerapps.io/
- Local: `pnpm install`, then `pnpm --filter @parkwright/web dev` and open http://localhost:5180.

## First run

- Do: open the game. See: a title screen with **Continue**, **New park** (pick Meadow or Sandbox and name your park) and **How to play**.
- Do: start a park. See: a four-card welcome (Next/Back/Skip, arrow keys, Esc). Then **Show me how** starts a hands-on walkthrough that highlights each control and waits for you: pick Path, drag a path from the gate, open Rides, place a ride, place a stall, inspect it, speed up time. **End tour** stops it at any point.
- Do: press `?` or the **?** button in the top bar. See: the rules and controls sheet, with buttons to replay the welcome, restart the walkthrough or start a new park. Add `?play` to the URL to skip the title screen.
- Do: look at the top bar and toolbar. See: one set of line icons (no emoji): the park name, Cash, Rating and Visitors pills, pause and speed buttons with the speaker, then Finance, Visitors, Staff, Parks, the terminal and help. Panels slide in; on a phone the top bar is three rows (name and speeds, stats, menu) and the toolbar is a bottom bar.
- Do: let a park day run (90 s at 1×). See: the light follow the park's clock: a warm morning, a long day, a golden evening and a short blue dusk where the bulbs on rides, lamps and the gate glow and lamps pool light on the paths. Purely visual; the sim doesn't know the time of day. In the console, `parkwright.world.timeOfDay = 0.93` pins the dusk look (`null` lets it run again).
- Do: click a ride with **Inspect**. See: its panel, and a pulsing gold outline round it in the park.
- Do: open **Rides → Timber Coaster**, click a tile for the station, then point at a piece button. See: a see-through preview of that piece at the track's open end, with the tiles it takes and an arrow for where the track heads next. It's green if the piece fits; red if it doesn't, with the reason in the panel (e.g. "tile 48,34 is not clear"). Pieces that can't fit are dimmed. With nothing hovered, it previews the last piece you added.

- Do: open the game on a phone or tablet. See:
  - one finger taps to build or select, and drags to lay paths (with **Inspect** selected, a drag pans);
  - two fingers pinch to zoom, drag to pan, and a quarter twist turns the view;
  - **⟲ R ⟳** buttons in the bottom-right corner turn the view and rotate the piece you're placing.
  - On a desktop, right-drag also pans.

- Do: click anywhere, build a path and a ride, and let time run. See (hear): a thunk for building, a tick for each path tile, a chime as visitors arrive, coins as they spend, a little tune when a ride starts, the chain clack and rush of a coaster run, and a crowd murmur that grows with the park. It's all synthesized in the browser (no audio files). **M**, or the speaker button at the end of the speed controls in the top bar, mutes it and the setting is remembered.

Press `` ` `` to open the park terminal and type `help`. Try `path place 24 33 24 40`, then `ride build teacups 21 34 --rot 1`, then `ride open teacups`. Visitors walk in from the gate and queue for the ride.

## Tests

- Do: `pnpm test`. See: the sim, server, chain and AI unit tests.
- Do: `pnpm --filter @parkwright/sim balance --days 42 --every 7`. See: three reference parks (starter, mid, big) built with `pw` commands, with visitors, rating, cash, income, spend per day and ms per simulated day. A good mid-sized park reaches about 1,000–1,300 visitors in three weeks. Add `--stress 500,1000,1500` to time one day at each crowd size, or `--rules 1` for the original rules (see DESIGN §6.1).
- Do: `pnpm e2e` (first time: `pnpm --filter @parkwright/e2e exec playwright install chromium`). See: it builds the web app, starts the real server on :8931 with file saves and no chain or AI keys, and headless Chromium checks the title screen and New park flow, building a path and a ride (ride count up, cash down by the cost), `?` and Esc for How to play, and Publish & share followed by `/api/parks/<id>/verify` reporting `verified: true`, with no console errors. CI runs the same in the `e2e` job and uploads the Playwright report when it fails.

## Host it

`scripts/deploy-azure.sh` builds the image in Azure Container Registry and rolls out the Azure Container App (resource group `parkwright`, North Europe). The first run creates everything. It prints the URL and checks `/api/health`.

## NEAR (testnet)

Visitors arrive in 8 groups. Each group is paid for by an agent with its own NEAR account (`g0`–`g7.parkwright.testnet`), whose only key can call `settle_day` and nothing else. When a park syncs to the cloud, each agent settles its visitors' spend for every finished day into the park, on the contract `park.parkwright.testnet`.

- Do: open the game, build a ride, press **Parks → Publish & share**, and let two in-game days pass. See: the Parks panel shows "On NEAR testnet" with the credits settled into your park, and a link to the contract on NearBlocks.
- Do (owner, once): `./scripts/set-insights-secret.sh`. See: an Application Insights resource `parkwright-insights` on the app's Log Analytics workspace; after the restart, *Live metrics*, *Failures* and *Performance* in the portal show the server's requests, Redis/Cosmos/NEAR calls and exceptions (25% of requests sampled; `INSIGHTS_SAMPLING` changes it).
- Do (owner, once): `./scripts/backup-policy.sh`. See: Cosmos DB keeps a geo-redundant backup every 4 hours for 7 days (`backupRetentionIntervalInHours: 168`) instead of 8 hours.
- Do: `curl $URL/api/parks/<id>/verify`. See: whether the server's replay of every action reproduced the save exactly. Only verified parks settle on NEAR or appear on the leaderboard.
- Do: `curl $URL/api/parks/<id>/chain`. See: the park's escrow, earnings and settlement count, read from the contract, plus `claimed`.
- Do: publish a park, keep playing until the Parks panel shows **✓ Verified**, then press **Claim on NEAR** and pick a testnet wallet in the NEAR Connect picker (e.g. Meteor or HOT). See: the wallet asks you to sign "Claim Parkwright park <id>" (a message, not a transaction, so no gas), then the panel shows you as **Owner**, and `/chain` reports `"claimed": true`. Once it has earned something, **Withdraw earnings** asks your wallet to sign a `withdraw` call (1 yoctoNEAR), and the escrow moves to your CR balance (`ft_balance_of`).
- Do: `cd contracts/park && cargo test`. See: 18 tests covering caps, replays, withdrawals, transfers and credit conservation.
- Setup (once, by the owner): `cargo near deploy …` (see DESIGN §9), then `pnpm --filter @parkwright/chain setup:patrons`.
- Do: `pnpm check:gas`. See: a table of the NEAR balance of `parkwright.testnet` and `g0`–`g7` (they pay their own gas), read with the public `view_account` RPC. It exits 1 if any is below 0.1 NEAR (`GAS_MIN_NEAR=0.5 pnpm check:gas` to change that). The `gas-watch` workflow runs it every 6 hours and opens an issue labelled `low-gas` (or comments on the open one). With settlement on, `curl $URL/api/health` shows the same as `gas.low`, refreshed at most every 10 minutes.

## AI park manager and AI mods (NEAR AI, private inference)

Both run on a TEE-attested model on NEAR AI Cloud. The model can only propose `pw` commands or a data-only mod, which the game validates like any player input. Your browser checks each reply's TEE signature itself: the signature must cover exactly that request and reply, and the signing key must be in the model's attestation report.

- Do: open the terminal (`` ` ``) and type `ask "build a swing ride and a lemonade stand and connect them" --budget 3000`. See: the manager says what it's doing, runs `pw` commands, recovers from errors using the game's hints, and prints "🔏 signed in a TEE … verified here" for each turn.
- Do: `mod ai "a haunted drop tower and a hot cocoa cart"`, then `mod apply`. See: the new ride and stall in the Rides and Stalls drawers and in `pw ride types`. Ids are namespaced and every number is clamped, so a mod can't break the game or replace base content. Published parks carry their mods, so visitors see them too.
- Do: `ai proofs`. See: a JSON download with the exact signed request/response bytes and signatures, which anyone can re-check.
- Do: `pw ride place teacups`. See: the game finds room near the paths, builds, connects the entrance and opens the ride (the manager uses this too).

## Let Claude Code play your park (MCP)

- Do: in the game's terminal, type `bridge`. See: a one-time link like `https://…/mcp/<code>` and the command to add it.
- Do: in a shell, `claude mcp add --transport http parkwright <that link>`, then ask Claude "use the parkwright tools to build me a food court". See: each command Claude runs appears in your terminal as `claude › pw …`, and the camera follows it.
- Tools: `pw` (any terminal command) and `park_overview` (status, rides, finance, thoughts). Commands run in your tab through the same validated actions as yours. The link is the only key: 128 bits, valid only while the tab is open. `bridge off` revokes it.
- Hosted, the server relays between replicas through Redis pub/sub, so it works whichever replica Claude's requests land on.
## 3D models (Blender)

The ride, stall and scenery models (five kinds of broadleaf tree, three conifers, three flower beds, two hedges, the fountain, benches, lamps, bins, the park fence and gate, the arch over each ride entrance and the coaster car) are generated by Python scripts in Blender (`assets/blender/models.py`, `common.py`). The built `.glb` files are committed, so you don't need Blender to play.

- Do: `./scripts/build-assets.sh` (needs Blender 4.x; set `BLENDER=` if it isn't on your PATH). See: 9 files in `apps/web/public/models` (8 rides and stalls plus `scenery.glb`) and `manifest.json`; each export prints its triangle count.
- Conventions: 1 unit = 1 tile, origin at the footprint centre, fronts face −Y in Blender (+Z in the game). Parts named `spin`, `wheel` or `carriage` animate while the ride runs, and `hang*` cabins on a wheel stay level. Parts painted `accent` take the ride's colour in the game (a stall's roof and awning, a ride's entrance arch, each coaster car). A scenery kind with several looks (`prop_oak_a` … `prop_oak_e`) gets one per tile for trees and one per 4×4 block for beds and hedges, so a planted row matches. Any model missing from the manifest falls back to the procedural mesh, which is how mod rides look.

## Claude terminal (local only): mod with your own Claude Code

On your own machine, the game's terminal can run your real `claude` CLI, connected to your park.

- Do: `PW_CLAUDE_TERMINAL=1 pnpm --filter @parkwright/server start` (after building the web app), open http://localhost:8790, open the terminal and type `claude`. See: Claude Code inside the game. Ask it, for example, "make a mod with a balloon stall and a gentle kiddie coaster-like flat ride, load it and place one". It writes mod files in `mods/workspace/`, loads them with the `mod_apply` tool (validated like `mod ai`), and builds with `pw`. Ctrl+] returns to the park terminal.
- Limits: it's off unless `PW_CLAUDE_TERMINAL=1`, and only a loopback request with a `localhost` Host from a same-origin page can open it. The hosted image never sets the flag. Claude is pre-approved only for this park's tools plus reading and editing files inside `mods/workspace/`; other paths ask you, and it can't edit its own `.claude` settings. Bash and web tools are disallowed, and everything else still asks you first.
- Needs `claude` and `python3` on your PATH (a tiny Python helper gives it a real terminal; no native Node modules).
