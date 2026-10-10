# LHD Internal Tooling
## Description
This is a monorepository of every project Longhorn Internal Tooling manages. It is managed as
a pnpm workspace. The majority of projects use Cloudflare products and are deployed with Wrangler.

## Contributing
Contribution is managed through PRs. All PRs should explain exactly what issue they are fixing
or feature they are adding, and code must be well organized. Here are the expected steps:
1. Fork the repository
2. Create a new branch for your feature or bug fix
3. Open a Pull Request explaining all of your changes

## Projects
### MCP Server
An LHD-hosted MCP Server through the Cloudflare MCP Server product. It has various tools connecting to
a wide swathe of LHD products to provide UT students with UT-specific knowledge and tools built-in to
their chatbots.

### Membership Management Portal
A membership management portal for LHD, handling both applicant tracking and member membership and on-
and off-boarding. This is specifically the **backend** logic for the management, as frontend is handled
by the Website team.