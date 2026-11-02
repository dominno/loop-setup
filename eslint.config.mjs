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
      // Worktree-isolated agents check out here; flat config does not read .gitignore,
      // so a leftover worktree would otherwise be linted with the root project.
      ".claude/worktrees/**",
    ],
  },
  ...next,
];

export default eslintConfig;
