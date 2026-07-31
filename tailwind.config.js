/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        seed: {
          bg: 'var(--seed-bg)',
          fg: 'var(--seed-fg)',
          primary: 'var(--seed-primary)',
          accent: 'var(--seed-accent)',
          surface: 'var(--seed-surface)',
        },
        status: {
          success: 'var(--color-success)',
          progress: 'var(--color-progress)',
          'ai-review': 'var(--color-ai-review)',
          'human-review': 'var(--color-human-review)',
          manual: 'var(--color-manual)',
          pending: 'var(--color-pending)',
          error: 'var(--color-error)',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        'seed': 'var(--seed-radius)',
      }
    },
  },
  plugins: [],
}
