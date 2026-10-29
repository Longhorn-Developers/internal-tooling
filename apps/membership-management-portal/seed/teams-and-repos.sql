-- Teams and the org repositories each one owns (team_repos).
--
-- Apply locally:     pnpm exec wrangler d1 execute membership_db --local --file seed/teams-and-repos.sql
-- Apply to prod:     pnpm exec wrangler d1 execute membership_db --remote --file seed/teams-and-repos.sql
--                    (only after migration 0001 is applied with `pnpm run db:migrate`)
--
-- Safe to re-run: existing teams keep their name and slug, and repos move to the team listed here.
-- This only writes D1. Run the GitHub sync afterwards to apply team Write / lead Admin.
--
-- Team IDs are the GitHub team slugs. If a GitHub team doesn't exist yet, the sync creates it;
-- its name slugifies to the same slug.
--
-- Unassigned (no matching team yet; the orphan check will flag them):
--   Degree-Audit-Plus, Spark-Plus, SSO-Proxy, Uninstall-Page, ut-calculator-plus
-- Skipped (archived; ignored by the sync and the orphan check):
--   lhd-vinyl-rewrites-html, lhd-vinyl-rewrites-jsx, lhd-vinyl-rewrites-jsx-template,
--   lhd-vinyl-rewrites-ts, Longhorn-Developers-Website, old-Longhorn-Studies
-- Private repositories aren't visible without a token; add them below.

INSERT INTO teams (id, name, github_team_slug) VALUES
    ('ut-registration-plus', 'UT Registration Plus', 'ut-registration-plus'),
    ('ut-dining', 'UT Dining', 'ut-dining'),
    ('ut-lectures-plus', 'UT Lectures Plus', 'ut-lectures-plus'),
    ('help-me-bevo', 'Help Me Bevo', 'help-me-bevo'),
    ('longhorn-studies', 'Longhorn Studies', 'longhorn-studies'),
    ('longhorn-lifts', 'Longhorn Lifts', 'longhorn-lifts'),
    ('longhorn-loop', 'Longhorn Loop', 'longhorn-loop'),
    ('mobilize-ut', 'Mobilize UT', 'mobilize-ut'),
    ('ut-marketplace', 'UT Marketplace', 'ut-marketplace'),
    ('pet-bevo', 'Pet Bevo', 'pet-bevo'),
    ('internal-tooling', 'Internal Tooling', 'internal-tooling'),
    ('lhd-website', 'LHD Website', 'lhd-website')
ON CONFLICT(id) DO NOTHING;

INSERT INTO team_repos (repo_name, team_id) VALUES
    ('UT-Registration-Plus', 'ut-registration-plus'),
    ('ut-registration-minus', 'ut-registration-plus'),
    ('UT-Dining', 'ut-dining'),
    ('ut-dining-website', 'ut-dining'),
    ('UT-Lectures-Plus', 'ut-lectures-plus'),
    ('Help-Me-Bevo', 'help-me-bevo'),
    ('Longhorn-Studies', 'longhorn-studies'),
    ('Longhorn-Lifts', 'longhorn-lifts'),
    ('Longhorn-Loop', 'longhorn-loop'),
    ('Mobilize-UT', 'mobilize-ut'),
    ('Mobilize', 'mobilize-ut'),
    ('UT-Marketplace', 'ut-marketplace'),
    ('Pet-Bevo', 'pet-bevo'),
    ('internal-tooling', 'internal-tooling'),
    ('LHD-Website', 'lhd-website')
ON CONFLICT(repo_name) DO UPDATE SET team_id = excluded.team_id;
