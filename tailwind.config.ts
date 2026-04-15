import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // MargenticOS design system — see /docs/design.md for full palette
        'brand-green': '#1C3A2A',
        'brand-green-operator': '#1A2E1A',
        'brand-green-accent': '#A8D4B8',
        'brand-green-success': '#3B6D11',
        'brand-amber': '#EF9F27',
        'surface-shell': '#EDE8DF',
        'surface-content': '#F8F4EE',
        'surface-card': '#FFFFFF',
        'border-card': '#E8E2D8',
        'text-primary': '#1A1916',
        'text-secondary': '#9A9488',
        'text-muted': '#C8C3B8',
      },
    },
  },
  plugins: [],
}
export default config
