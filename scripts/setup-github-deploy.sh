#!/usr/bin/env bash
# One-time: let GitHub Actions deploy to Azure with OIDC — no stored secrets.
# Creates a deploy-only app registration + service principal, trusts only this repo's `production`
# environment, grants Contributor on the parkwright resource group (nothing wider), and sets the
# repo variables the deploy workflow reads. Safe to re-run.
set -euo pipefail
REPO=${REPO:-lopeselio/parkwright}
RG=${RG:-parkwright}
NAME=${NAME:-parkwright-github-deploy}

SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
APP_ID=$(az ad app list --display-name "$NAME" --query '[0].appId' -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$NAME" --query appId -o tsv)
fi
az ad sp show --id "$APP_ID" -o none 2>/dev/null || az ad sp create --id "$APP_ID" -o none
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)

SUBJECT="repo:${REPO}:environment:production"
if [ -z "$(az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$SUBJECT'].name" -o tsv)" ]; then
  az ad app federated-credential create --id "$APP_ID" --parameters "{\"name\":\"github-production\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"$SUBJECT\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none
fi

RG_ID=$(az group show -n "$RG" --query id -o tsv)
if [ -z "$(az role assignment list --assignee "$SP_ID" --scope "$RG_ID" --role Contributor --query '[0].id' -o tsv)" ]; then
  az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal --role Contributor --scope "$RG_ID" -o none
fi

# Booleans must be JSON booleans, so send a JSON body (gh's -f would send "false" as a string).
echo '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
  | gh api -X PUT "repos/$REPO/environments/production" --input - >/dev/null
gh api -X POST "repos/$REPO/environments/production/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true
gh variable set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
gh variable set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUB"
echo "deploy identity $NAME ($APP_ID): Contributor on $RG, trusted for $SUBJECT"
