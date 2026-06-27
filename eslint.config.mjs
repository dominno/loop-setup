import next from "eslint-config-next";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "dist/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...next,
];

export default eslintConfig;
