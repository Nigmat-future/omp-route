import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "bin", "omp-route.js");

const fakeOmpSource = `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const base = {
  contextWindow: 1000000,
  maxTokens: 64000,
  reasoning: true,
  thinking: ["low", "medium", "high"],
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};
const models = [
  { ...base, provider: "alpha", id: "claude-fable-5", selector: "alpha/claude-fable-5", name: "Claude Fable 5" },
  { ...base, provider: "beta", id: "anthropic/claude-fable-5", selector: "beta/anthropic/claude-fable-5", name: "Claude Fable 5" }
];
if (args[0] === "models") {
  if (process.env.FAKE_MODELS_INVALID) process.stdout.write("not-json");
  else process.stdout.write(JSON.stringify({ models }));
} else if (args[0] === "usage") {
  if (process.env.FAKE_USAGE_FAIL) {
    process.stderr.write("usage unavailable");
    process.exitCode = 9;
  } else {
    process.stdout.write(JSON.stringify({ reports: [{ provider: "beta", limits: [{ amount: { remainingFraction: 0.75 } }] }] }));
  }
} else if (args[0] === "--config") {
  writeFileSync(process.env.FAKE_OMP_RECORD, JSON.stringify({ args, overlay: JSON.parse(readFileSync(args[1], "utf8")) }));
} else {
  process.stderr.write("unexpected fake OMP arguments: " + JSON.stringify(args));
  process.exitCode = 3;
}
`;

const setup = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-route-test-"));
  const fakeOmp = path.join(directory, "fake-omp.mjs");
  const record = path.join(directory, "record.json");
  const routeDir = path.join(directory, "routes");
  await writeFile(fakeOmp, fakeOmpSource);
  const env = {
    ...process.env,
    OMP_ROUTE_OMP_COMMAND: process.execPath,
    OMP_ROUTE_OMP_PREFIX_ARGS: JSON.stringify([fakeOmp]),
    OMP_ROUTE_DIR: routeDir,
    FAKE_OMP_RECORD: record,
  };
  return { directory, env, record, routeDir };
};

const run = (args, env) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: projectRoot,
  env,
  encoding: "utf8",
  timeout: 20_000,
});

test("CLI discovers models and usage from an OMP subprocess", async () => {
  const state = await setup();
  const result = run(["plan", "--match", "fable", "--json"], state.env);

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.fallbackChains["alpha/claude-fable-5"], [
    "beta/anthropic/claude-fable-5",
  ]);
  assert.match(plan.routes[0].fallbacks[0].reasons.join(" "), /75% quota remaining/);
});

test("run writes the overlay before forwarding arguments to OMP", async () => {
  const state = await setup();
  const result = run([
    "run",
    "--match",
    "fable",
    "--",
    "--model",
    "claude-fable-5",
    "continue",
  ], state.env);

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(await readFile(state.record, "utf8"));
  assert.equal(record.args[0], "--config");
  assert.equal(record.args[1], path.join(state.routeDir, "routes.generated.yml"));
  assert.deepEqual(record.args.slice(2), ["--model", "claude-fable-5", "continue"]);
  assert.deepEqual(record.overlay.retry.fallbackChains["alpha/claude-fable-5"], [
    "beta/anthropic/claude-fable-5",
  ]);
});

test("usage failure degrades to compatibility routing", async () => {
  const state = await setup();
  state.env.FAKE_USAGE_FAIL = "1";
  const result = run(["plan", "--match", "fable", "--json"], state.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /usage data unavailable/);
  assert.equal(JSON.parse(result.stdout).routes.length, 2);
});

test("invalid model discovery output fails without launching OMP", async () => {
  const state = await setup();
  state.env.FAKE_MODELS_INVALID = "1";
  const result = run(["run", "--match", "fable"], state.env);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /returned invalid JSON/);
});
