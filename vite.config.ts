import { defineConfig } from "vite-plus";

export default defineConfig({
    test: {
        include: ["apps/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    },
    fmt: {
        printWidth: 100,
        tabWidth: 4,
        useTabs: false,
        ignorePatterns: [
            // Responses captured from UT, kept exactly as served.
            "**/test/fixtures/**",
            "**/worker-configuration.d.ts",
            "**/dist/**",
            "**/*.md",
            "**/*.css",
            ".github/**",
            "**/wrangler.jsonc",
        ],
        overrides: [
            // Preserve prior quote/semi conventions; only tabs→spaces is intentional globally.
            {
                files: ["apps/mcp-server/**"],
                options: {
                    singleQuote: false,
                    semi: true,
                },
            },
            {
                files: ["apps/lhd-ui/**", "apps/membership-management-portal/**"],
                options: {
                    singleQuote: true,
                    semi: false,
                },
            },
        ],
    },
    lint: {
        plugins: ["typescript"],
        categories: {
            correctness: "error",
            suspicious: "warn",
            perf: "warn",
        },
        rules: {
            "no-debugger": "off",
            "no-unused-vars": [
                "error",
                {
                    caughtErrorsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    argsIgnorePattern: "^_",
                },
            ],
            "no-await-in-loop": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "no-shadow": "off",
            "vite-plus/prefer-vite-plus-imports": "error",
        },
        ignorePatterns: ["**/worker-configuration.d.ts", "**/dist/**"],
        options: {
            typeAware: true,
            typeCheck: true,
        },
        jsPlugins: [
            {
                name: "vite-plus",
                specifier: "vite-plus/oxlint-plugin",
            },
        ],
        overrides: [
            {
                files: ["apps/lhd-ui/**"],
                plugins: ["react"],
                rules: {
                    "react/react-in-jsx-scope": "off",
                },
            },
        ],
    },
});
