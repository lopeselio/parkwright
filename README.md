# Parkwright

An original theme-park builder in three.js. You build paths, flat rides, coasters and stalls, and simulated guests decide whether your park is worth their money. Guests are agents with NEAR testnet wallets and spending caps. The park manager can be you, typing in the in-game terminal, or an AI running on private (TEE) inference.

Work in progress. See DESIGN.md.

## Play

- Hosted (testnet demo): https://parkwright.whitemeadow-d4da3d5d.northeurope.azurecontainerapps.io/
- Local: `pnpm install`, then `pnpm --filter @parkwright/web dev` and open http://localhost:5180.

Press `` ` `` to open the park terminal and type `help`. Try `path place 24 33 24 40`, then `ride build teacups 21 34 --rot 1`, then `ride open teacups`. Visitors walk in from the gate and queue for the ride.

## Host it

`scripts/deploy-azure.sh` builds the image in Azure Container Registry and rolls out the Azure Container App (resource group `parkwright`, North Europe). The first run creates everything. It prints the URL and checks `/api/health`.
