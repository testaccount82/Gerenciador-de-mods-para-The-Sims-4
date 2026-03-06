/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron.js',
  },
  setupFiles: ['<rootDir>/tests/setup.js'],
  testTimeout: 15000,
  verbose: true,
};
