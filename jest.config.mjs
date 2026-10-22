/**
 * Jest configuration for unit tests.
 *
 * Three settings are load-bearing:
 *
 *  * `tsconfig.spec.json` supplies the explicit `rootDir` that ts-jest needs in
 *    order to compute the common source directory.
 *  * ESM mode (`extensionsToTreatAsEsm` + `useESM`) is required because NestJS 12
 *    ships ESM-only packages, which a CommonJS test runtime cannot `require`.
 *    That is why the npm scripts pass `--experimental-vm-modules`.
 *  * The extension-stripping `moduleNameMapper` entry: the generated Prisma
 *    client imports its siblings with explicit `.js` extensions (the ESM
 *    convention) even though the files on disk are `.ts`, so Jest's strict ESM
 *    resolver would not find them without the rewrite.
 */
export default {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json', useESM: true }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/main.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/src/generated/'],
  coverageDirectory: './coverage',
  // Only enforced when coverage is collected (`npm run test:cov`, which CI runs).
  // A path key applies to the files under it, aggregated (BN-REQ-OPS-009):
  // measured 83.2 % lines for src/payments when the gate was introduced.
  coverageThreshold: {
    './src/payments/': { lines: 80 },
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
