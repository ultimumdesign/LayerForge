export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) => /^(?![a-z][a-z0-9-]*(?:\([^)]+\))?!?:)[^\r\n]+ \(#\d+\)\r?\n\r?\n\* /i.test(message)
  ],
  rules: {
    'body-max-line-length': [2, 'always', 200],
    'footer-max-line-length': [2, 'always', 200]
  }
};
