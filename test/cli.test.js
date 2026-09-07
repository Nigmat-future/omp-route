import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

const models = [
  {
    provider: "cctq-claude",
    id: "claude-fable-5",
    selector: "cctq-claude/claude-fable-5",
    name: "Claude Fable 5 (CCTQ)",
    contextWindow: 1_000_000,
    maxTokens: 16_384,
    reasoning: true,
    thinking: ["low", "medium", "high", "xhigh"],
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    provider: "cursor",
    id: "claude-fable-5-high",
    selector: "cursor/claude-fable-5-high",
    name: "Claude Fable 5 1M",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    reasoning: true,
    thinking: ["low", "medium", "high"],
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    provider: "openrouter",
    id: "anthropic/claude-fable-5",
    selector: "openrouter/anthropic/claude-fable-5",
    name: "Claude Fable 5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    thinking: ["low", "medium", "high", "xhigh", "max"],
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
];

const usage = {
  reports: [
    { provider: "cursor", limits: [{ amount: { remainingFraction: 0.8 } }] },
    { provider: "openrouter", limits: [{ amount: { remainingFraction: 0.5 } }] },
  ],
};

const harness = () => {
  const stdout = [];
  const stderr = [];
  const writes = [];
  const launches = [];
  return {
    stdout,
    stderr,
    writes,
    launches,
    deps: {
      getModels: async () => models,
      getUsage: async () => usage,
      writeOverlay: async (filePath, overlay) => writes.push({ filePath, overlay }),
      launchOmp: async (args) => {
        launches.push(args);
        return 0;
      },
      homeDir: () => "C:\\Users\\test",
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
  };
};

test("scan lists canonical groups and provider selectors", async () => {
  const state = harness();
  const code = await runCli(["scan", "fable"], state.deps);

  assert.equal(code, 0);
  const output = state.stdout.join("");
  assert.match(output, /claude-fable@5/);
  assert.match(output, /cctq-claude\/claude-fable-5/);
  assert.match(output, /cursor\/claude-fable-5-high/);
  assert.equal(state.writes.length, 0);
});

test("plan emits machine-readable fallback chains", async () => {
  const state = harness();
  const code = await runCli([
    "plan",
    "--json",
    "--prefer",
    "openrouter,cursor,cctq-claude",
  ], state.deps);

  assert.equal(code, 0);
  const output = JSON.parse(state.stdout.join(""));
  assert.deepEqual(output.fallbackChains["cctq-claude/claude-fable-5"], [
    "openrouter/anthropic/claude-fable-5",
    "cursor/claude-fable-5-high",
  ]);
});

test("explain filters routes and includes ranking reasons", async () => {
  const state = harness();
  const code = await runCli(["explain", "cctq-claude/claude-fable-5"], state.deps);

  assert.equal(code, 0);
  const output = state.stdout.join("");
  assert.match(output, /80% quota remaining/);
  assert.match(output, /50% quota remaining/);
  assert.doesNotMatch(output, /source: cursor/);
});

test("run writes a generated overlay and launches OMP with passthrough arguments", async () => {
  const state = harness();
  const code = await runCli([
    "run",
    "--prefer=cursor,openrouter",
    "--",
    "--model",
    "fable",
    "continue the task",
  ], state.deps);

  assert.equal(code, 0);
  assert.equal(state.writes.length, 1);
  assert.equal(
    state.writes[0].filePath,
    path.join("C:\\Users\\test", ".omp-route", "routes.generated.yml"),
  );
  assert.ok(state.writes[0].overlay.retry.fallbackChains);
  assert.deepEqual(state.launches, [[
    "--config",
    state.writes[0].filePath,
    "--model",
    "fable",
    "continue the task",
  ]]);
});

test("run refuses to launch when no cross-provider groups exist", async () => {
  const state = harness();
  state.deps.getModels = async () => [models[0]];
  const code = await runCli(["run"], state.deps);

  assert.equal(code, 2);
  assert.equal(state.launches.length, 0);
  assert.match(state.stderr.join(""), /No safe cross-provider fallback routes found/);
});

test("plan limits automatic routes to matching model groups", async () => {
  const state = harness();
  state.deps.getModels = async () => [
    ...models,
    { ...models[0], provider: "glm-a", id: "glm-5.3", selector: "glm-a/glm-5.3", name: "GLM 5.3" },
    { ...models[0], provider: "glm-b", id: "glm-5.3", selector: "glm-b/glm-5.3", name: "GLM 5.3" },
  ];
  const code = await runCli(["plan", "--json", "--match", "fable"], state.deps);

  assert.equal(code, 0);
  const output = JSON.parse(state.stdout.join(""));
  assert.equal(output.routes.length, 3);
  assert.ok(output.routes.every((route) => route.canonicalKey === "claude-fable@5"));
});

test("run infers its route scope from a passthrough model selector", async () => {
  const state = harness();
  state.deps.maxAutoRoutes = 3;
  state.deps.getModels = async () => [
    ...models,
    { ...models[0], provider: "glm-a", id: "glm-5.3", selector: "glm-a/glm-5.3", name: "GLM 5.3" },
    { ...models[0], provider: "glm-b", id: "glm-5.3", selector: "glm-b/glm-5.3", name: "GLM 5.3" },
  ];
  const code = await runCli(["run", "--", "--model", "fable"], state.deps);

  assert.equal(code, 0);
  assert.equal(state.writes[0].overlay.retry.fallbackChains["glm-a/glm-5.3"], undefined);
});

test("run refuses an unsafe unscoped overlay with too many routes", async () => {
  const state = harness();
  state.deps.maxAutoRoutes = 2;
  const code = await runCli(["run"], state.deps);

  assert.equal(code, 2);
  assert.equal(state.launches.length, 0);
  assert.match(state.stderr.join(""), /--match/);
});

test("help does not call OMP", async () => {
  const state = harness();
  let called = false;
  state.deps.getModels = async () => {
    called = true;
    return [];
  };
  const code = await runCli(["--help"], state.deps);

  assert.equal(code, 0);
  assert.equal(called, false);
  assert.match(state.stdout.join(""), /omp-route run/);
});
