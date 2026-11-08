#!/usr/bin/env bash
# One-time (owner): give the hosted server its NEAR keys, from ~/.near-credentials, as Container App secrets.
#   - park-admin-key: the function-call key on parkwright.testnet limited to register_park/set_patron/fund_patrons
#   - patron-keys:    JSON map of p0…p7.parkwright.testnet → their settle_day-only keys
# Neither key can move NEAR or call anything else. Run after `pnpm --filter @parkwright/chain setup:patrons`.
set -euo pipefail
RG=${RG:-parkwright}
APP=${APP:-parkwright}
ADMIN=${ADMIN:-parkwright.testnet}
CREDS=${CREDS:-$HOME/.near-credentials/testnet}

ADMIN_KEY=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['private_key'])" "$CREDS/$ADMIN.server-key.json")
PATRON_KEYS=$(python3 -c "
import json,sys
d,admin=sys.argv[1],sys.argv[2]
print(json.dumps({f'p{i}.{admin}': json.load(open(f'{d}/p{i}.{admin}.json'))['private_key'] for i in range(8)}))" "$CREDS" "$ADMIN")

az containerapp secret set -g "$RG" -n "$APP" --secrets "park-admin-key=$ADMIN_KEY" "patron-keys=$PATRON_KEYS" -o none
az containerapp update -g "$RG" -n "$APP" -o none --set-env-vars \
  "PARK_ADMIN_KEY=secretref:park-admin-key" "PATRON_KEYS=secretref:patron-keys" "PARK_CONTRACT_ID=park.$ADMIN" "PARK_ADMIN_ID=$ADMIN"
echo "secrets set; the next revision starts with settlement on (check /api/health → \"settlement\": true)"
