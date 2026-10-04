import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const bunGlobals = {
  Bun: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '.git/**',
      '.state/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.angular/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...bunGlobals,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...bunGlobals,
        describe: 'readonly',
        expect: 'readonly',
        test: 'readonly',
      },
    },
  },
  {
    files: ['shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-control-regex': 'off',
    },
  },
);
