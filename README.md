# Parkwright

An original theme-park builder in three.js. You build paths, flat rides, coasters and stalls, and simulated guests decide whether your park is worth their money. Guests are agents with NEAR testnet wallets and spending caps. The park manager can be you, typing in the in-game terminal, or an AI running on private (TEE) inference.

Work in progress. See DESIGN.md.

## Play

- Hosted (testnet demo): https://parkwright.whitemeadow-d4da3d5d.northeurope.azurecontainerapps.io/
- Local: `pnpm install`, then `pnpm --filter @parkwright/web dev` and open http://localhost:5180.

Press `` ` `` to open the park terminal and type `help`. Try `path place 24 33 24 40`, then `ride build teacups 21 34 --rot 1`, then `ride open teacups`. Visitors walk in from the gate and queue for the ride.

## Host it

`scripts/deploy-azure.sh` builds the image in Azure Container Registry and rolls out the Azure Container App (resource group `parkwright`, North Europe). The first run creates everything. It prints the URL and checks `/api/health`.

## NEAR (testnet)

Visitors arrive in 8 groups. Each group is paid for by an agent with its own NEAR account (`p0`–`p7.parkwright.testnet`), whose only key can call `settle_day` and nothing else. When a park syncs to the cloud, each agent settles its visitors' spend for every finished day into the park, on the contract `park.parkwright.testnet`.

- Do: open the game, build a ride, press **Parks → Publish & share**, and let two in-game days pass. See: the Parks panel shows "On NEAR testnet" with the credits settled into your park, and a link to the contract on NearBlocks.
- Do: `curl $URL/api/parks/<id>/chain`. See: the park's escrow, earnings and settlement count, read from the contract.
- Do: `cd contracts/park && cargo test`. See: 18 tests covering caps, replays, withdrawals, transfers and credit conservation.
- Setup (once, by the owner): `cargo near deploy …` (see DESIGN §9), then `pnpm --filter @parkwright/chain setup:patrons`.
