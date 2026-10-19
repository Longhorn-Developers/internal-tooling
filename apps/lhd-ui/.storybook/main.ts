import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'

const config: StorybookConfig = {
    stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
    addons: ['@storybook/addon-links', '@storybook/addon-docs'],
    framework: {
        name: '@storybook/react-vite',
        options: {},
    },
    async viteFinal(config) {
        config.plugins = [...(config.plugins || []), tailwindcss()]
        return config
    },
}

export default config
