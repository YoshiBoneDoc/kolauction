import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  // Ignore build/dist folders
  { ignores: ['dist'] },

  // Configuration for React frontend files
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser, // Browser-based globals for React apps
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: { react: { version: '18.3' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/jsx-no-target-blank': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // Configuration for Node.js backend files (e.g., Lambda handlers)
  {
    files: ['**/backend/**/*.js'], // Apply only to backend files
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node, // Enable Node.js globals (e.g., `require`, `module`)
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'script', // Use CommonJS for Node.js files
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Add any Node.js-specific rules if needed
    },
  },
]