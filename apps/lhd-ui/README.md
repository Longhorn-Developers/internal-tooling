# LHD Component Library

Shared React UI component library for Longhorn Developers. Components are built and reviewed in [Storybook](https://storybook.js.org/), then published for consumption as `@longhorn-developers/lhd-ui`.

## Requirements

- [pnpm](https://pnpm.io/) (this monorepo uses `pnpm@12`)
- React 18 or 19 (peer dependency)

## Getting started

From the monorepo root:

```bash
pnpm install
```

Useful scripts (run from `apps/lhd-ui`, or via `pnpm --filter @longhorn-developers/lhd-ui <script>`):

| Script | Description |
|--------|-------------|
| `pnpm storybook` | Start [Storybook](https://storybook.js.org/) locally on [http://localhost:6006](http://localhost:6006) |
| `pnpm build` | Build the library (`dist/` — CJS, ESM, and types) |
| `pnpm dev` | Watch-mode build with `vp pack` |
| `pnpm build-storybook` | Produce a static Storybook site |

### Storybook

Storybook is the primary way to develop and review components. Stories live next to their components and are picked up by the glob in [`.storybook/main.ts`](./.storybook/main.ts):

```text
src/**/*.stories.@(js|jsx|mjs|ts|tsx)
```

Start it with:

```bash
cd apps/lhd-ui
pnpm storybook
```

Then open [http://localhost:6006](http://localhost:6006). Use Storybook’s Controls and Docs panels (via `@storybook/addon-essentials`) to exercise variants before opening a PR.

## Including the library

`@longhorn-developers/lhd-ui` is a React component library. Your app must already provide React and React DOM (18 or 19).

### In an external project

Install the published package with your package manager:

```bash
pnpm add @longhorn-developers/lhd-ui
# or: npm install @longhorn-developers/lhd-ui
# or: yarn add @longhorn-developers/lhd-ui
```

Ensure React peers are installed (skip if your app already has them):

```bash
pnpm add react react-dom
```

### Importing components

Import named exports from the package root:

```tsx
import { Button } from '@longhorn-developers/lhd-ui';

export function Example() {
  return <Button>Click me</Button>;
}
```

The package ships dual CJS/ESM builds plus TypeScript types from `dist/`. Only public exports from [`src/index.ts`](./src/index.ts) are available to consumers — do not deep-import from internal paths.

## Project layout

```text
apps/lhd-ui/
├── .storybook/          # Storybook config (main + preview)
├── src/
│   ├── components/      # One folder per component
│   │   └── Button/
│   │       ├── Button.tsx
│   │       └── Button.stories.tsx
│   └── index.ts         # Public barrel exports
├── tsup.config.ts       # Library build
└── package.json
```

### Adding a component

1. Create `src/components/<Name>/<Name>.tsx` for the implementation.
2. Add `<Name>.stories.tsx` in the same folder so it appears in Storybook.
3. Re-export the component from [`src/index.ts`](./src/index.ts).
4. Verify in Storybook (`pnpm storybook`), then run `pnpm build` to confirm the library build succeeds.

## Contributing

Contribution is managed through pull requests. PRs that add or change UI must include the new/updated components and matching Storybook stories.

1. **Fork** this repository.
2. Implement your component(s) under `src/components/`, export them from `src/index.ts`, and cover them with stories.
3. Validate locally with Storybook (`pnpm storybook`) and a library build (`pnpm build`).
4. Open a **Pull Request targeting the `lhd-ui` branch** (not `main`). The PR should describe what was added or changed and link any related issue.

PRs that only touch tooling/docs for this package should still target `lhd-ui` unless maintainers ask otherwise.
