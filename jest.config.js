/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@lattice/canonical/(.*)$': '<rootDir>/libs/canonical/src/$1',
    '^@lattice/canonical$': '<rootDir>/libs/canonical/src/index.ts',
    '^@lattice/adapters/(.*)$': '<rootDir>/libs/adapters/src/$1',
    '^@lattice/adapters$': '<rootDir>/libs/adapters/src/index.ts',
    '^@lattice/sync-core/(.*)$': '<rootDir>/libs/sync-core/src/$1',
    '^@lattice/sync-core$': '<rootDir>/libs/sync-core/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
