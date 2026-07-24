'use strict';

// Flat config for ESLint v9. Replaces the legacy .eslintrc.json.
// This project is plain CommonJS Node code (no JSX, no TS) so we use
// the recommended Node globals only — no @eslint/js recommended set,
// which would flag `require`/`__dirname` usage patterns we rely on.

const globals = require('globals');

module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          // Optional catch binding (catch {}) is preferred for unused errors;
          // allow `catch (_)` as a fallback for explicit intent.
          caughtErrors: 'none',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'error',
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'test/fixtures/', 'lib/proxy.js'],
  },
];
