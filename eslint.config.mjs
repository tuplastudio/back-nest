import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint configuration.
 *
 * Beyond the usual TypeScript rules this configuration encodes two hard
 * security invariants of the codebase:
 *
 * 1. Raw SQL that is built by string concatenation or interpolation is
 *    forbidden. Only tagged-template helpers (`Prisma.sql` / `Prisma.raw` /
 *    `Prisma.join`) may be used, which guarantees parameter binding.
 * 2. The *Unsafe variants of the Prisma raw APIs (`$queryRawUnsafe`,
 *    `$executeRawUnsafe`) are banned everywhere. The only sanctioned escape
 *    hatch lives in `src/database/safe-sql/` and is explicitly re-enabled with
 *    an inline `eslint-disable` comment plus a justification.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**', 'coverage/**', 'docs/openapi.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Type safety -----------------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],

      // --- SQL injection prevention --------------------------------------
      // Building SQL through interpolation is the root cause of SQL injection.
      // NOTE: `object` is deliberately omitted. Pinning it to `prisma` only
      // matches a member expression whose object is literally the identifier
      // `prisma`, which is not how this codebase reaches the client: the real
      // call sites are `this.prisma.client.$executeRawUnsafe(...)` and
      // `tx.$executeRawUnsafe(...)`. Matching on the property name alone is what
      // actually makes the rule fire. Existing offenders are acknowledged inline
      // with an `eslint-disable` plus a justification.
      'no-restricted-properties': [
        'error',
        {
          property: '$queryRawUnsafe',
          message:
            '$queryRawUnsafe is forbidden. Use `$queryRaw(Prisma.sql`...`)` with bound parameters, or the audited `SafeSql` helpers.',
        },
        {
          property: '$executeRawUnsafe',
          message:
            '$executeRawUnsafe is forbidden. Use `$executeRaw(Prisma.sql`...`)` with bound parameters, or the audited `SafeSql` helpers.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Blocks template-literal SQL in $queryRaw/$executeRaw (missing tag function).
          selector:
            'CallExpression[callee.property.name=/^(?:\\$queryRaw|\\$executeRaw)$/][arguments.0.type=TemplateLiteral]',
          message:
            'Raw SQL template literals must be tagged with `Prisma.sql` so values are bound as parameters, e.g. `prisma.$queryRaw(Prisma.sql`SELECT * FROM t WHERE id = ${id}`)`.',
        },
        {
          // Blocks string concatenation inside raw calls.
          selector:
            'CallExpression[callee.property.name=/^(?:\\$queryRaw|\\$executeRaw)$/][arguments.0.type=BinaryExpression]',
          message: 'Raw SQL string concatenation is forbidden. Use the tagged `Prisma.sql` template instead.',
        },
      ],

      // --- Documentation ---------------------------------------------------
      // Every public surface of this base is documented; keep it that way.
      'jsdoc/require-jsdoc': 'off',
    },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts', 'prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  prettier,
);
