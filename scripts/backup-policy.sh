#!/usr/bin/env bash
# Cosmos DB backups for park saves: periodic, every 4 hours, kept for 7 days, geo-redundant.
# (The default keeps each backup only 8 hours, so a bad write found the next day couldn't be restored.)
# Periodic mode is kept on purpose: moving to continuous backup can't be undone.
# Restores go through Azure support for periodic mode: see https://learn.microsoft.com/azure/cosmos-db/periodic-backup-restore-introduction
set -euo pipefail
RG=${RG:-parkwright}
ACCOUNT=${ACCOUNT:-parkwright-db}
HOURS=${HOURS:-168}
az cosmosdb update -g "$RG" -n "$ACCOUNT" --backup-interval 240 --backup-retention "$HOURS" --backup-redundancy Geo -o none
az cosmosdb show -g "$RG" -n "$ACCOUNT" --query backupPolicy.periodicModeProperties -o json
