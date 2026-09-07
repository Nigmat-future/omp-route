import os from "node:os";
import path from "node:path";

import {
  buildFallbackPlan,
  createOverlay,
  groupEquivalentModels,
} from "./core.js";
import {
  getModels,
  getUsage,
  launchOmp,
  writeOverlay,
} from "./omp.js";

const HELP = `Usage:
  omp-route scan [query]
  omp-route plan [--match query] [--json] [--prefer provider-a,provider-b]
  omp-route explain [query] [--prefer provider-a,provider-b]
  omp-route run [--match query] [--prefer provider-a,provider-b] [--profile high] [-- OMP_ARGS...]

Commands:
  scan      List high-confidence equivalent models across providers
  plan      Preview generated fallback chains
  explain   Explain the ordering for matching routes
  run       Generate an overlay and launch OMP
`;

const parseArguments = (argv) => {
  const args = [...argv];
  if (args.length === 0) return { command: "run", options: {}, positionals: [], passthrough: [] };
  if (args[0] === "--help" || args[0] === "-h") return { command: "help", options: {}, positionals: [], passthrough: [] };
  const command = ["scan", "plan", "explain", "run"].includes(args[0]) ? args.shift() : null;
  if (!command) throw new Error(`Unknown command: ${args[0]}`);

  const options = {};
  const positionals = [];
  const separator = args.indexOf("--");
  const passthrough = separator >= 0 ? args.splice(separator + 1) : [];
  if (separator >= 0) args.pop();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg.startsWith("--match=")) {
      options.match = arg.slice("--match=".length);
      continue;
    }
    if (arg === "--match") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--match requires a model query");
      options.match = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--prefer=")) {
      options.providerOrder = arg.slice("--prefer=".length).split(",").filter(Boolean);
      continue;
    }
    if (arg === "--prefer") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--prefer requires a comma-separated provider list");
      options.providerOrder = value.split(",").filter(Boolean);
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      options.defaultProfile = arg.slice("--profile=".length);
      continue;
    }
    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--profile requires a value");
      options.defaultProfile = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return { command, options, positionals, passthrough };
};

const writeLine = (stream, value = "") => stream.write(`${value}\n`);

const matchesQuery = (group, query) => {
  if (!query) return true;
  const needle = query.toLowerCase();
  return group.canonicalKey.toLowerCase().includes(needle)
    || group.models.some((model) => [model.selector, model.name].some((value) => String(value).toLowerCase().includes(needle)));
};

const modelsMatchingQuery = (models, query) => {
  if (!query) return models;
  return groupEquivalentModels(models)
    .filter((group) => matchesQuery(group, query))
    .flatMap((group) => group.models);
};

const passthroughModel = (args) => {
  const inline = args.find((arg) => arg.startsWith("--model="));
  if (inline) return inline.slice("--model=".length);
  const index = args.indexOf("--model");
  return index >= 0 ? args[index + 1] : null;
};

const printGroups = (groups, stdout) => {
  writeLine(stdout, `Found ${groups.length} cross-provider model group${groups.length === 1 ? "" : "s"}.`);
  for (const group of groups) {
    writeLine(stdout, `\n${group.canonicalKey}`);
    for (const model of group.models) writeLine(stdout, `  ${model.selector}`);
  }
};

const printPlan = (plan, stdout) => {
  writeLine(stdout, `Generated ${plan.routes.length} fallback route${plan.routes.length === 1 ? "" : "s"}.`);
  for (const route of plan.routes) {
    writeLine(stdout, `\nsource: ${route.source} (${route.canonicalKey})`);
    route.fallbacks.forEach((fallback, index) => {
      writeLine(stdout, `  ${index + 1}. ${fallback.selector} — ${fallback.reasons.join(", ")}`);
    });
  }
};

const loadPlan = async (deps, options, query) => {
  const modelsPromise = deps.getModels();
  const usagePromise = deps.getUsage().catch((error) => {
    writeLine(deps.stderr, `Warning: usage data unavailable; routing by compatibility and preferences. ${error.message}`);
    return {};
  });
  const [models, usage] = await Promise.all([modelsPromise, usagePromise]);
  return buildFallbackPlan(modelsMatchingQuery(models, query), usage, options);
};

const defaultDependencies = {
  getModels,
  getUsage,
  writeOverlay,
  launchOmp,
  homeDir: os.homedir,
  maxAutoRoutes: 200,
  stdout: process.stdout,
  stderr: process.stderr,
};

export const runCli = async (argv, overrides = {}) => {
  const deps = { ...defaultDependencies, ...overrides };
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === "help" || parsed.options.help) {
      deps.stdout.write(HELP);
      return 0;
    }

    if (parsed.command === "scan") {
      const models = await deps.getModels();
      const groups = groupEquivalentModels(models)
        .filter((group) => matchesQuery(group, parsed.positionals.join(" ")));
      if (parsed.options.json) writeLine(deps.stdout, JSON.stringify(groups, null, 2));
      else printGroups(groups, deps.stdout);
      return groups.length > 0 ? 0 : 2;
    }

    const routeQuery = parsed.options.match
      ?? (parsed.command === "run" ? passthroughModel(parsed.passthrough) : parsed.positionals.join(" "));
    const plan = await loadPlan(deps, parsed.options, routeQuery);
    if (parsed.command === "plan") {
      if (parsed.options.json) writeLine(deps.stdout, JSON.stringify(plan, null, 2));
      else printPlan(plan, deps.stdout);
      return plan.routes.length > 0 ? 0 : 2;
    }

    if (parsed.command === "explain") {
      const query = parsed.positionals.join(" ").toLowerCase();
      const routes = query
        ? plan.routes.filter((route) => route.source.toLowerCase().includes(query) || route.canonicalKey.toLowerCase().includes(query))
        : plan.routes;
      if (parsed.options.json) writeLine(deps.stdout, JSON.stringify(routes, null, 2));
      else printPlan({ routes }, deps.stdout);
      return routes.length > 0 ? 0 : 2;
    }

    if (plan.routes.length === 0) {
      writeLine(deps.stderr, "No safe cross-provider fallback routes found; OMP was not launched.");
      return 2;
    }
    if (!routeQuery && !parsed.options.all && plan.routes.length > deps.maxAutoRoutes) {
      writeLine(deps.stderr, `Refusing to generate ${plan.routes.length} unscoped routes. Use --match <model> or --all.`);
      return 2;
    }
    const routeDirectory = process.env.OMP_ROUTE_DIR || path.join(deps.homeDir(), ".omp-route");
    const overlayPath = path.join(routeDirectory, "routes.generated.yml");
    await deps.writeOverlay(overlayPath, createOverlay(plan));
    writeLine(deps.stdout, `Generated ${plan.routes.length} routes in ${overlayPath}`);
    return await deps.launchOmp(["--config", overlayPath, ...parsed.passthrough]);
  } catch (error) {
    writeLine(deps.stderr, `omp-route: ${error.message}`);
    return 1;
  }
};

export { HELP, parseArguments };
