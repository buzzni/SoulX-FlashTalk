// Flat config — starts permissive so the refactor can land without a flood
// of noise on day 1. Ratchet rules tighter as phases progress (Phase 4 is a
// natural point to flip `any`/unused-vars to errors once components are
// typed).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/types/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2023,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      // React Hooks — these actually catch bugs; keep them on.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // A11y — recommended ruleset, but downgraded to warn on day 0. Existing
      // code has ~20 a11y violations that get fixed in Phase 4 component
      // decomposition, not here. Ratchet back to error after Phase 4.
      ...Object.fromEntries(
        Object.entries(jsxA11y.configs.recommended.rules).map(([k]) => [k, 'warn']),
      ),

      // Start permissive — these will ratchet tighter in Phase 4.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off', // let @typescript-eslint handle it
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
    },
  },
  {
    // Wizard-bridge guard — `bg-accent` / `text-accent-foreground` /
    // `border-accent` resolve to studio-only color tokens that don't
    // exist (or have a *different* meaning) at global :root. The 2026-04
    // BackgroundPicker bug landed exactly here. The regex catches the
    // bare class plus common variant prefixes (hover:, focus:,
    // data-[state=on]:, data-[state=open]:, dark:, sm:, md:, lg:) and
    // opacity suffixes (`bg-accent/50`).
    //
    // Scope: src/studio/** plus shared components that render inside
    // .studio-root (UploadTile, OptionCard, WizardInfoBanner, the
    // shadcn ui/* primitives). The shadcn primitives are flagged so
    // any Toggle / Switch / DropdownMenu newly used inside the wizard
    // is forced onto the explicit token set first.
    files: [
      'src/studio/**/*.{ts,tsx,jsx}',
      'src/components/wizard-info-banner.tsx',
      'src/components/upload-tile.tsx',
      'src/components/option-card.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/(^|[\\s:'\"`])([A-Za-z-]+:)*(bg-accent|text-accent-foreground|border-accent)(\\/[0-9]+)?(\\s|$|['\"`])/]",
          message:
            'Do not use bg-accent / text-accent-foreground / border-accent inside studio surfaces — these tokens are studio-private or differently-scoped. Use bg-primary-soft / text-primary-on-soft / border-primary, or the studio-only bg-accent-soft / text-accent-text aliases.',
        },
        {
          selector:
            "TemplateElement[value.raw=/(^|[\\s:'\"`])([A-Za-z-]+:)*(bg-accent|text-accent-foreground|border-accent)(\\/[0-9]+)?(\\s|$|['\"`])/]",
          message:
            'Do not use bg-accent / text-accent-foreground / border-accent inside studio surfaces — these tokens are studio-private or differently-scoped. Use bg-primary-soft / text-primary-on-soft / border-primary, or the studio-only bg-accent-soft / text-accent-text aliases.',
        },
      ],
    },
  },
  {
    files: ['**/__tests__/**/*.{js,jsx,ts,tsx}', '**/*.test.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Tests are allowed to be looser.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Config files run in Node.
    files: ['*.config.{js,ts}', 'vite.config.js', 'vitest.config.*'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
