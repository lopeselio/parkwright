#!/usr/bin/env bash
# One-time: create the data services and wire them to the Container App.
#   - Cosmos DB for NoSQL (serverless): database "parkwright", container "parks" (partition key /id).
#     The app reaches it with a user-assigned managed identity (data-plane RBAC), no keys.
#   - Azure Managed Redis (cache, leaderboard, rate limits). Its access key goes into the app as a secret.
# Safe to re-run: every step checks before creating.
set -euo pipefail
RG=${RG:-parkwright}
LOC=${LOC:-northeurope}
APP=${APP:-parkwright}
COSMOS=${COSMOS:-parkwright-db}
REDIS=${REDIS:-parkwright-redis}
# North and West Europe had no Cosmos capacity for this subscription (Nov 2026); Sweden Central did.
COSMOS_LOC=${COSMOS_LOC:-swedencentral}
REDIS_LOC=${REDIS_LOC:-westeurope}
IDENTITY=${IDENTITY:-parkwright-data}

az provider register -n Microsoft.DocumentDB --wait -o none
az provider register -n Microsoft.Cache --wait -o none

# --- identity the app uses for Cosmos
if ! az identity show -g "$RG" -n "$IDENTITY" -o none 2>/dev/null; then
  az identity create -g "$RG" -n "$IDENTITY" -o none
fi
ID_RES=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
ID_PRINCIPAL=$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
ID_CLIENT=$(az identity show -g "$RG" -n "$IDENTITY" --query clientId -o tsv)

# --- Cosmos DB (serverless)
# A capacity error can leave an account in the Failed state. Deleting is irreversible, so it needs DELETE_FAILED=1.
if [ "$(az cosmosdb show -g "$RG" -n "$COSMOS" --query provisioningState -o tsv 2>/dev/null)" = "Failed" ]; then
  if [ "${DELETE_FAILED:-}" = 1 ]; then
    az cosmosdb delete -g "$RG" -n "$COSMOS" --yes -o none
  else
    echo "Cosmos account $COSMOS is in the Failed state. Re-run with DELETE_FAILED=1 to delete and recreate it (or pick another COSMOS name)." >&2
    exit 1
  fi
fi
if ! az cosmosdb show -g "$RG" -n "$COSMOS" -o none 2>/dev/null; then
  az cosmosdb create -g "$RG" -n "$COSMOS" --capabilities EnableServerless \
    --locations regionName="$COSMOS_LOC" failoverPriority=0 isZoneRedundant=false \
    --default-consistency-level Session --disable-key-based-metadata-write-access true -o none
fi
az cosmosdb sql database show -g "$RG" -a "$COSMOS" -n parkwright -o none 2>/dev/null \
  || az cosmosdb sql database create -g "$RG" -a "$COSMOS" -n parkwright -o none
az cosmosdb sql container show -g "$RG" -a "$COSMOS" -d parkwright -n parks -o none 2>/dev/null \
  || az cosmosdb sql container create -g "$RG" -a "$COSMOS" -d parkwright -n parks --partition-key-path /id -o none
# Built-in "Cosmos DB Data Contributor" for the app identity, scoped to the parkwright database only.
COSMOS_ID=$(az cosmosdb show -g "$RG" -n "$COSMOS" --query id -o tsv)
if [ -z "$(az cosmosdb sql role assignment list -g "$RG" -a "$COSMOS" --query "[?principalId=='$ID_PRINCIPAL'].id" -o tsv)" ]; then
  az cosmosdb sql role assignment create -g "$RG" -a "$COSMOS" --scope "$COSMOS_ID/dbs/parkwright" \
    --principal-id "$ID_PRINCIPAL" --role-definition-id 00000000-0000-0000-0000-000000000002 -o none
fi
COSMOS_ENDPOINT=$(az cosmosdb show -g "$RG" -n "$COSMOS" --query documentEndpoint -o tsv)

# --- Azure Managed Redis
if ! az redisenterprise show -g "$RG" -n "$REDIS" -o none 2>/dev/null; then
  az redisenterprise create -g "$RG" -n "$REDIS" -l "$REDIS_LOC" --sku Balanced_B0 \
    --public-network-access Enabled --access-keys-auth Enabled --clustering-policy EnterpriseCluster -o none
fi
REDIS_HOST=$(az redisenterprise show -g "$RG" -n "$REDIS" --query hostName -o tsv)
REDIS_KEY=$(az redisenterprise database list-keys -g "$RG" --cluster-name "$REDIS" --query primaryKey -o tsv)
REDIS_URL="rediss://default:${REDIS_KEY}@${REDIS_HOST}:10000"

# --- wire into the Container App
if az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az containerapp identity assign -g "$RG" -n "$APP" --user-assigned "$ID_RES" -o none
  az containerapp secret set -g "$RG" -n "$APP" --secrets "redis-url=$REDIS_URL" -o none
  az containerapp update -g "$RG" -n "$APP" -o none --set-env-vars \
    "COSMOS_ENDPOINT=$COSMOS_ENDPOINT" "AZURE_CLIENT_ID=$ID_CLIENT" "REDIS_URL=secretref:redis-url" "STORE=cosmos"
fi
echo "cosmos: $COSMOS_ENDPOINT"
echo "redis:  $REDIS_HOST:10000"
