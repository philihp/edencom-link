import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const config = [
  {
    // src/app/.well-known/workflow is generated (and gitignored) by the
    // workflow compiler (withWorkflow in next.config.mjs) on every build.
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'src/app/.well-known/workflow/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default config
