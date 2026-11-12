#!/usr/bin/env bash
# Starts the test UI locally, with the portal bundled into the one local worker (as deployed).
# It runs under the portal's wrangler.jsonc (its staging env), which has no D1 binding. The shim
# in test-ui/src/worker.ts then sends the portal's SQL to the deployed worker's /api/sql, so no
# Cloudflare login is needed.
#
# Two env files, both downloaded from Notion:
#   .dev.vars          staging GitHub App credentials (also what cf-typegen reads)
#   test-ui/.dev.vars  STAGING_DB_URL and STAGING_DB_TOKEN (kept out of the portal's generated types)
set -euo pipefail

cd "$(dirname "$0")/.."

dev_vars_url="https://app.notion.com/p/longhorn-developers/Membership-Management-Portal-3f7d9cb37133803eb6b5cedd0048409c"

for file in .dev.vars test-ui/.dev.vars; do
    if [[ ! -f $file ]]; then
        cat >&2 <<EOF

Missing $file (staging credentials), relative to apps/membership-management-portal.
Download it from Notion and put it there:
  $dev_vars_url

EOF
        exit 1
    fi
done

cat <<'EOF'

STAGING test UI
  local:  the test UI and all membership portal code, called through ctx.exports (real RPC)
  remote: the shared staging database (through the deployed test UI's /api/sql) and the
          lhd-staging GitHub org; everyone testing uses the same data
  The GitHub webhook is not local: it runs on the deployed staging worker.

EOF

# -e staging has no D1 binding (bindings aren't inherited), so no local database is created;
# --local means no Cloudflare login is needed. Passing --env-file replaces Wrangler's automatic
# .dev.vars lookup, so both files are listed (later ones override earlier ones).
exec pnpm exec wrangler dev test-ui/src/worker.ts --assets test-ui/public --local -e staging \
    -c wrangler.jsonc --env-file .dev.vars --env-file test-ui/.dev.vars
