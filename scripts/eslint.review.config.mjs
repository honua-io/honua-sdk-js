import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/artifacts/**', 'playgrounds/**', 'src/gen/**', 'test/fixtures/**', '**/coverage/**', '**/test-results/**'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './scripts/tsconfig.review.json', tsconfigRootDir: fileURLToPath(new URL('../', import.meta.url)) },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
    rules: {
      'max-params': ['error', 3],
      'max-depth': ['error', 2],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];
