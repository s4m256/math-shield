const { spawnSync } = require("node:child_process");
const path = require("node:path");

const requested = Number.parseInt(process.env.MATHSHIELD_ITERATIONS || "3", 10);
const iterations = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 5) : 3;
const playwrightCli = path.join(
  __dirname,
  "..",
  "node_modules",
  "@playwright",
  "test",
  "cli.js"
);

console.log(`Running MathShield E2E loop with ${iterations} iteration(s) per page.`);
const result = spawnSync(process.execPath, [playwrightCli, "test"], {
  cwd: path.resolve(__dirname, ".."),
  env: { ...process.env, MATHSHIELD_ITERATIONS: String(iterations) },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
