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
    // Studio scope guard — `bg-accent` / `text-accent-foreground` resolve to
    // *different* colors inside `.studio-root` than at global :root, because
    // wizard tokens redefine the same names. The 2026-04 BackgroundPicker
    // bug landed exactly here. Force studio components onto explicit
    // `bg-primary-soft` / `text-primary-on-soft` (or the studio-scoped
    // `bg-accent-soft` / `text-accent-text` aliases that don't have the
    // same trap).
    files: ['src/studio/**/*.{ts,tsx,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/(^|\\s)(bg-accent|text-accent-foreground|border-accent)(\\s|$)/]",
          message:
            'Do not use bg-accent / text-accent-foreground / border-accent inside src/studio/* — token resolves to deep blue here. Use bg-primary-soft / text-primary-on-soft / border-primary, or the studio-only bg-accent-soft / text-accent-text aliases.',
        },
        {
          selector:
            "TemplateElement[value.raw=/(^|\\s)(bg-accent|text-accent-foreground|border-accent)(\\s|$)/]",
          message:
            'Do not use bg-accent / text-accent-foreground / border-accent inside src/studio/* — token resolves to deep blue here. Use bg-primary-soft / text-primary-on-soft / border-primary, or the studio-only bg-accent-soft / text-accent-text aliases.',
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
