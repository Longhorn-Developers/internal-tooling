#!/usr/bin/env bash
# Starts the test UI and the portal (../wrangler.jsonc) together. Usage: start.sh remote|local|reset
#   remote: the portal's D1 binding is remote, and dev resolves it to the staging database via
#           preview_database_id (needs Cloudflare access: `wrangler login`)
#   local:  --local disables the remote binding, so D1 is a local copy, migrated here
#           (needs no Cloudflare access)
#   reset:  deletes the local database and other local dev state (.wrangler/state)
set -euo pipefail

cd "$(dirname "$0")/.."

dev_vars_url="https://app.notion.com/p/longhorn-developers/Membership-Management-Portal-3f7d9cb37133803eb6b5cedd0048409c"

mode="${1:-}"
wrangler=(pnpm exec wrangler)

if [[ "$mode" != reset && ! -f .dev.vars ]]; then
    cat >&2 <<EOF

Missing .dev.vars (the staging GitHub App credentials and settings).
Download it from Notion and put it in apps/membership-management-portal:
  $dev_vars_url

EOF
    exit 1
fi

case "$mode" in
remote)
    label="STAGING"
    flags=()
    cat <<'EOF'

STAGING test UI, shared staging database
  local:  the test UI and all membership portal code (reached through a service binding)
  remote: the staging D1 database (membership-db-staging) and the lhd-staging GitHub org
  EXCEPT the GitHub webhook path: it runs on the deployed Cloudflare staging preview worker
  (same staging D1), because GitHub cannot reach this machine.

EOF
    ;;
local)
    label="LOCAL DB (webhook unavailable)"
    flags=(--local --persist-to .wrangler/state)

    # Safe to repeat: applied migrations are skipped.
    "${wrangler[@]}" d1 migrations apply membership_db --local --persist-to .wrangler/state

    cat <<'EOF'

STAGING test UI, local database
  local:  the test UI, all membership portal code, and a local D1 copy (.wrangler/state)
  remote: the lhd-staging GitHub org (GitHub writes are real)
  The GitHub webhook will NOT work: it only runs on the deployed Cloudflare staging worker,
  which uses the shared staging D1 rather than this local database.

EOF
    ;;
reset)
    rm -rf .wrangler/state
    echo "Deleted the local database (.wrangler/state). It is recreated by the next staging:local."
    exit 0
    ;;
*)
    echo "Usage: $0 remote|local|reset" >&2
    exit 1
    ;;
esac

exec "${wrangler[@]}" dev -c test-ui/wrangler.jsonc -c wrangler.jsonc \
    --var "TARGET_LABEL:$label" ${flags[@]+"${flags[@]}"}
