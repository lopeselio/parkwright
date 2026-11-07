#!/usr/bin/env bash
# Deploy Parkwright to Azure Container Apps.
# First run creates the resource group, registry, environment and app; later runs build a new image and roll the app.
set -euo pipefail
RG=${RG:-parkwright}
LOC=${LOC:-northeurope}
APP=${APP:-parkwright}
ENV_NAME=${ENV_NAME:-parkwright-env}
TAG=${TAG:-$(git rev-parse --short HEAD)}
cd "$(dirname "$0")/.."

az group create -n "$RG" -l "$LOC" -o none
ACR=${ACR:-$(az acr list -g "$RG" --query '[0].name' -o tsv)}
if [ -z "$ACR" ]; then
  ACR="parkwright$(openssl rand -hex 3)"
  az acr create -g "$RG" -n "$ACR" --sku Basic -o none
fi

az acr build -r "$ACR" -t "parkwright:$TAG" --build-arg "APP_VERSION=$TAG" .
IMAGE="$ACR.azurecr.io/parkwright:$TAG"

if ! az containerapp env show -g "$RG" -n "$ENV_NAME" -o none 2>/dev/null; then
  az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOC" -o none
fi

if az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az containerapp update -g "$RG" -n "$APP" --image "$IMAGE" -o none
else
  # The app pulls from the registry with its own managed identity (no admin password).
  az containerapp create -g "$RG" -n "$APP" --environment "$ENV_NAME" --image "$IMAGE" \
    --registry-server "$ACR.azurecr.io" --registry-identity system \
    --target-port 8080 --ingress external --min-replicas 1 --max-replicas 3 \
    --cpu 0.5 --memory 1.0Gi -o none
fi

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$FQDN/"
curl -fsS "https://$FQDN/api/health" && echo
