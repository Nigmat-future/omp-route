import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const redact = (value) => String(value ?? "")
  .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]")
  .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted]")
  .trim();

const commandName = () => process.env.OMP_ROUTE_OMP_COMMAND || "omp";

const commandPrefixArgs = () => {
  const raw = process.env.OMP_ROUTE_OMP_PREFIX_ARGS;
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("OMP_ROUTE_OMP_PREFIX_ARGS must be a JSON string array");
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("OMP_ROUTE_OMP_PREFIX_ARGS must be a JSON string array");
  }
  return value;
};

const readJsonCommand = (args, spawnSyncImpl = spawnSync) => {
  const result = spawnSyncImpl(commandName(), [...commandPrefixArgs(), ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Unable to run OMP: ${redact(result.error.message)}`);
  if (result.status !== 0) {
    throw new Error(`OMP ${args.join(" ")} failed: ${redact(result.stderr) || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`OMP ${args.join(" ")} returned invalid JSON`);
  }
};

export const getModels = async () => {
  const result = readJsonCommand(["models", "--json"]);
  if (!Array.isArray(result?.models)) throw new Error("OMP models output did not contain a models array");
  return result.models;
};

export const getUsage = async () => readJsonCommand(["usage", "--json", "--redact"]);

export const writeOverlay = async (filePath, overlay) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(overlay, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

export const launchOmp = async (args) => new Promise((resolve, reject) => {
  const child = spawn(commandName(), [...commandPrefixArgs(), ...args], {
    stdio: "inherit",
    windowsHide: false,
    shell: false,
  });
  child.once("error", (error) => reject(new Error(`Unable to launch OMP: ${redact(error.message)}`)));
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`OMP exited after signal ${signal}`));
    else resolve(code ?? 1);
  });
});
