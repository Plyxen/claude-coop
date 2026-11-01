import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/', '.wrangler/', '.claude/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.worker },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // These match control characters on purpose: they exist to remove them.
    files: ['src/validate.js', 'test/**/*.js'],
    rules: { 'no-control-regex': 'off' },
  },
]
