export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/**/*.jest.test.js", "<rootDir>/src/**/*.jest.test.jsx"],
  extensionsToTreatAsEsm: [".jsx"],
  transform: {
    "^.+\\.jsx$": "babel-jest",
  },
};
