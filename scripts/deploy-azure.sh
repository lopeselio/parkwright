#!/usr/bin/env bash
# Deploy Parkwright to Azure Container Apps.
# First run creates the resource group, registry, identity, environment and app; later runs build a new image and roll the app.
# Needs: az login, Owner or User Access Administrator on the subscription (for the AcrPull role assignment) on the first run.
# SKIP_SETUP=1 (used by CI): only build, roll and verify — needs no more than Contributor on the resource group.
set -euo pipefail
RG=${RG:-parkwright}
LOC=${LOC:-northeurope}
APP=${APP:-parkwright}
ENV_NAME=${ENV_NAME:-parkwright-env}
IDENTITY=${IDENTITY:-parkwright-pull}
# Commit + time: every run rolls a new revision, even when HEAD hasn't moved.
TAG=${TAG:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)}
cd "$(dirname "$0")/.."

az extension add -n containerapp --upgrade -y -o none 2>/dev/null || true
SETUP=${SKIP_SETUP:+no}
SETUP=${SETUP:-yes}
if [ "$SETUP" = yes ]; then
  for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry; do
    az provider register -n "$ns" --wait -o none
  done
  az group create -n "$RG" -l "$LOC" -o none
fi
ACR=${ACR:-$(az acr list -g "$RG" --query '[0].name' -o tsv)}
if [ -z "$ACR" ] && [ "$SETUP" = yes ]; then
  ACR="parkwright$(openssl rand -hex 3)"
  az acr create -g "$RG" -n "$ACR" --sku Basic -o none
fi

# A user-assigned identity with AcrPull, created before the app, so the first revision can pull.
if [ "$SETUP" = yes ] && ! az identity show -g "$RG" -n "$IDENTITY" -o none 2>/dev/null; then
  az identity create -g "$RG" -n "$IDENTITY" -o none
fi
ID_RES=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
ID_PRINCIPAL=$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
ACR_ID=$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)
if [ "$SETUP" = yes ] && [ -z "$(az role assignment list --assignee "$ID_PRINCIPAL" --scope "$ACR_ID" --role AcrPull --query '[0].id' -o tsv)" ]; then
  az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID" -o none
  echo "waiting for the AcrPull role to propagate…"
  sleep 60
fi

az acr build -r "$ACR" -t "parkwright:$TAG" --build-arg "APP_VERSION=$TAG" .
IMAGE="$ACR.azurecr.io/parkwright:$TAG"

if [ "$SETUP" = yes ] && ! az containerapp env show -g "$RG" -n "$ENV_NAME" -o none 2>/dev/null; then
  az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOC" -o none
fi

if az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  if [ "$SETUP" = yes ]; then
    # Move older deployments (system identity) to the user-assigned pull identity; harmless if already set.
    az containerapp identity assign -g "$RG" -n "$APP" --user-assigned "$ID_RES" -o none
    az containerapp registry set -g "$RG" -n "$APP" --server "$ACR.azurecr.io" --identity "$ID_RES" -o none
  fi
  az containerapp update -g "$RG" -n "$APP" --image "$IMAGE" -o none
else
  az containerapp create -g "$RG" -n "$APP" --environment "$ENV_NAME" --image "$IMAGE" \
    --user-assigned "$ID_RES" --registry-server "$ACR.azurecr.io" --registry-identity "$ID_RES" \
    --target-port 8080 --ingress external --min-replicas 1 --max-replicas 3 \
    --cpu 0.5 --memory 1.0Gi -o none
fi

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$FQDN/"
# Wait until the new revision answers with this build's version (not the old one still draining).
for _ in $(seq 1 30); do
  if curl -fsS "https://$FQDN/api/health" 2>/dev/null | grep -q "\"$TAG\""; then echo "live: $TAG"; exit 0; fi
  sleep 10
done
echo "the new revision didn't report $TAG within 5 minutes" >&2
exit 1
