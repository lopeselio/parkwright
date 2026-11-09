#!/usr/bin/env bash
# One-time: Application Insights for the hosted server. Creates a workspace-based App Insights resource on
# the Log Analytics workspace the Container App already logs to, stores its connection string as a
# Container App secret, and points APPLICATIONINSIGHTS_CONNECTION_STRING at it (apps/server/src/telemetry.ts).
# Safe to re-run. Run it yourself: it writes a secret.
set -euo pipefail
RG=${RG:-parkwright}
APP=${APP:-parkwright}
ENV_NAME=${ENV_NAME:-parkwright-env}
NAME=${NAME:-parkwright-insights}
az extension add -n application-insights -y >/dev/null 2>&1 || true
WS_CUSTOMER=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.appLogsConfiguration.logAnalyticsConfiguration.customerId -o tsv)
WS_ID=$(az monitor log-analytics workspace list -g "$RG" --query "[?customerId=='$WS_CUSTOMER'].id | [0]" -o tsv)
LOC=$(az group show -n "$RG" --query location -o tsv)
az monitor app-insights component show -g "$RG" -a "$NAME" -o none 2>/dev/null \
  || az monitor app-insights component create -g "$RG" -a "$NAME" -l "$LOC" --workspace "$WS_ID" --kind web --application-type web -o none
CONN=$(az monitor app-insights component show -g "$RG" -a "$NAME" --query connectionString -o tsv)
az containerapp secret set -g "$RG" -n "$APP" --secrets "insights-conn=$CONN" -o none
az containerapp update -g "$RG" -n "$APP" -o none --set-env-vars "APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:insights-conn"
echo "Application Insights '$NAME' connected; the new revision logs requests, dependencies and exceptions (25% sampled)."
echo "Portal: Application Insights → $NAME → Live metrics / Failures / Performance."
