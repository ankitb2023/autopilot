import path from 'node:path';
import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * ESLint configuration.
 *
 * Type-aware linting is enabled (`recommendedTypeChecked`) because the rules that
 * actually catch bugs in this codebase — floating promises, misused promises,
 * unsafe `any` flow — all require type information. `src/` is linted against the
 * real TS program; this config file is excluded from linting itself rather than
 * being shoehorned into the program.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      // Unused args are fine when prefixed with `_` (Express handler signatures).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Type-only imports must be explicit — keeps the CommonJS output clean.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A forgotten await on an automation call is a real bug, not a style nit.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'off',
      'no-console': 'error', // Winston only.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  prettier,
);
