import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        entry: ['src/index.ts'],
        format: ['cjs', 'esm'],
        dts: true,
        tsconfig: 'tsconfig.build.json',
        sourcemap: true,
        clean: true,
        // Match previous tsup output names (index.js / index.cjs / index.d.ts)
        // instead of tsdown's node-platform default (.mjs / .d.mts).
        platform: 'neutral',
        fixedExtension: false,
        deps: {
            neverBundle: ['react', 'react-dom'],
        },
    },
})
