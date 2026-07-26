import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-lambda/**', '**/coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['agent/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // `awslambda` is a global injected by the Lambda Node.js runtime only in response-
    // streaming invocations (see lambda.mjs) — real at deploy time, not a stray reference.
    files: ['agent/lambda.mjs'],
    languageOptions: {
      globals: {
        awslambda: 'readonly',
      },
    },
  },
  {
    files: ['agent/tests/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    files: ['memory/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['memory/tests/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    // pos-sync/, demo-seed/, and ops/ belong to another build track (see
    // docs/CONTRACTS.md) and are off limits for source edits from here. They
    // are plain Node ESM scripts, so this block only teaches ESLint about the
    // Node runtime they already run under — it does not change their code.
    files: ['pos-sync/**/*.mjs', 'demo-seed/**/*.mjs', 'ops/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // pos-sync/cli.mjs has an intentional empty catch around a best-effort
      // URL parse; allowed via config since the file isn't ours to edit.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['ops/**/*.test.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    files: ['web/src/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
  {
    files: ['web/tests/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    files: ['web/vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
];
