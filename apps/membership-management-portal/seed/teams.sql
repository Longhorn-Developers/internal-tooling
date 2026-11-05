-- LHD's project teams.
--
-- Apply locally:     pnpm exec wrangler d1 execute membership_db --local --file seed/teams.sql
-- Apply to prod:     pnpm exec wrangler d1 execute membership_db --remote --file seed/teams.sql
--
-- Safe to re-run: existing teams are left as they are.
--
-- Each team's GitHub team is the slug of its name (e.g. "UT Dining" -> ut-dining), so names must
-- match the GitHub teams. Which repositories a team owns is set on its GitHub team, not here.

INSERT INTO teams (id, name) VALUES
    ('ut-registration-plus', 'UT Registration Plus'),
    ('ut-dining', 'UT Dining'),
    ('ut-lectures-plus', 'UT Lectures Plus'),
    ('help-me-bevo', 'Help Me Bevo'),
    ('longhorn-studies', 'Longhorn Studies'),
    ('longhorn-lifts', 'Longhorn Lifts'),
    ('longhorn-loop', 'Longhorn Loop'),
    ('mobilize-ut', 'Mobilize UT'),
    ('ut-marketplace', 'UT Marketplace'),
    ('pet-bevo', 'Pet Bevo'),
    ('internal-tooling', 'Internal Tooling'),
    ('lhd-website', 'LHD Website')
ON CONFLICT(id) DO NOTHING;
