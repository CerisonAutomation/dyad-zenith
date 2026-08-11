module.exports = {
  "**/*.{ts,tsx}": () => "bun run ts",
  "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte}": "oxlint",
  "*": "oxfmt --no-error-on-unmatched-pattern",
};
