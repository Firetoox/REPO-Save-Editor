'use strict';
// ESLint (flat config). Run with `npm run lint`, which also checks the inline script of
// public/index.html (see scripts/lint.js).

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', '.data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // unused parameters often document a callback's shape (e.g. route handlers (q, body, ctx))
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      eqeqeq: ['error', 'smart'],
      strict: ['error', 'global'],
      'no-implicit-globals': 'error',
      'no-shadow': ['error', { builtinGlobals: false }],
      'no-throw-literal': 'error',
      'no-return-assign': 'error',
      'no-useless-concat': 'error',
      'object-shorthand': ['error', 'properties']
    }
  },
  {
    // the page script (lint.js passes it under this name); top-level names are used by test/ui-hidden.js
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-implicit-globals': 'off' }
  }
];
