#!/usr/bin/env bash
# One-time (owner): give the hosted server its NEAR AI Cloud key (Container App secret), read from an
# env file so the key never appears on screen. Usage: ./scripts/set-ai-secret.sh path/to/.env
set -euo pipefail
ENV_FILE=${1:?usage: set-ai-secret.sh <env file containing NEARAI_API_KEY=...>}
RG=${RG:-parkwright}
APP=${APP:-parkwright}
KEY=$(grep -E '^NEARAI_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
MODEL=$(grep -E '^NEARAI_MODEL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
[ -n "$KEY" ] || { echo "no NEARAI_API_KEY in $ENV_FILE" >&2; exit 1; }
az containerapp secret set -g "$RG" -n "$APP" --secrets "nearai-key=$KEY" -o none
az containerapp update -g "$RG" -n "$APP" -o none --set-env-vars "NEARAI_API_KEY=secretref:nearai-key" "NEARAI_MODEL=${MODEL:-Qwen/Qwen3.6-35B-A3B-FP8}"
echo "NEAR AI key set; check /api/health → \"ai\": \"${MODEL:-Qwen/Qwen3.6-35B-A3B-FP8}\""
