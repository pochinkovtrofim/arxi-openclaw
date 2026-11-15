import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { FLOW_NAME_PATTERN, FLOW_VERSION, type SavedFlow } from "./flows.js";

// Storage: one JSON file per flow under the principal's state directory, so
// flows belong to the same owner or group as the browser profile and survive
// sleep and runtime replacement.

export function flowsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.resolve(resolveStateDir(env)), "browser", "flows");
}

function flowPath(root: string, site: string, name: string): string {
  if (!/^[a-z0-9.-]+$/.test(site) || site.startsWith(".") || !FLOW_NAME_PATTERN.test(name)) {
    throw new Error("invalid flow site or name");
  }
  return path.join(root, site, `${name}.json`);
}

const FLOW_KEYS = new Set([
  "version",
  "name",
  "description",
  "site",
  "startUrl",
  "params",
  "request",
  "shape",
  "tier",
  "verified",
  "drift",
  "createdAt",
  "updatedAt",
]);

function parseFlow(text: string): SavedFlow | undefined {
  try {
    const value = JSON.parse(text) as SavedFlow;
    if (value.version !== FLOW_VERSION || !Object.keys(value).every((key) => FLOW_KEYS.has(key))) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export async function writeFlow(flow: SavedFlow, root = flowsRoot()): Promise<string> {
  const file = flowPath(root, flow.site, flow.name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return file;
}

export async function readFlow(
  name: string,
  site: string | undefined,
  root = flowsRoot(),
): Promise<SavedFlow | undefined> {
  if (site) {
    try {
      return parseFlow(await fs.readFile(flowPath(root, site, name), "utf8"));
    } catch {
      return undefined;
    }
  }
  const matches = (await listFlows(undefined, root)).filter((flow) => flow.name === name);
  if (matches.length > 1) {
    throw new Error(
      `several sites have a flow named ${name}: ${matches.map((f) => f.site).join(", ")}; pass flow.site`,
    );
  }
  return matches[0];
}

export async function listFlows(
  site: string | undefined,
  root = flowsRoot(),
): Promise<SavedFlow[]> {
  let sites: string[];
  try {
    sites = site ? [site] : await fs.readdir(root);
  } catch {
    return [];
  }
  const flows: SavedFlow[] = [];
  for (const entry of sites) {
    if (!/^[a-z0-9.-]+$/.test(entry)) {
      continue;
    }
    let files: string[];
    try {
      files = await fs.readdir(path.join(root, entry));
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".json")).toSorted()) {
      try {
        const flow = parseFlow(await fs.readFile(path.join(root, entry, file), "utf8"));
        if (flow) {
          flows.push(flow);
        }
      } catch {}
    }
  }
  return flows;
}

export async function deleteFlow(name: string, site: string, root = flowsRoot()): Promise<boolean> {
  try {
    await fs.unlink(flowPath(root, site, name));
    return true;
  } catch {
    return false;
  }
}

/** A short line per flow, for the agent to find them when it opens the site. */
export function describeFlows(flows: SavedFlow[]): string {
  return flows
    .map((flow) => {
      const params = flow.params.length > 0 ? `(${flow.params.join(", ")})` : "()";
      const state = flow.verified ? "" : " [unverified]";
      const write = flow.request.write ? " [write]" : "";
      return `${flow.name}${params}${write}${state}${flow.description ? ` — ${flow.description}` : ""}`;
    })
    .join("; ");
}
