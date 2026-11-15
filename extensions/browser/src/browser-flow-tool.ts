/**
 * browser_flow: saved flows as their own tool. They run through the browser
 * tool's own execution (the same profile, tab and routing), but keep their
 * parameters out of the browser tool's schema, which is at a provider's size
 * budget.
 */
import {
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export const BROWSER_FLOW_TOOL_NAME = "browser_flow";
const OPS = ["save", "run", "list", "delete"] as const;

export const BrowserFlowToolSchema = Type.Object({
  op: stringEnum(OPS),
  name: Type.Optional(Type.String({ description: "Flow name: a-z, 0-9, - or _." })),
  site: Type.Optional(Type.String({ description: "The site, when two sites share a flow name." })),
  description: Type.Optional(Type.String({ description: "save: what the flow does." })),
  params: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "save: each value you typed or picked in the task, by param name. run: the new values.",
      },
    ),
  ),
  where: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "run: keep records whose field (dotted path) contains the text.",
      },
    ),
  ),
  select: Type.Optional(
    Type.Array(Type.String(), { description: "run: return only these fields (dotted paths)." }),
  ),
  limit: optionalPositiveIntegerSchema({ description: "run: most records returned (default 10)." }),
  output: Type.Optional(
    Type.String({ description: "save: a candidate id, to save another request." }),
  ),
  via: optionalStringEnum(["auto", "device"] as const, {
    description: "run: device sends it from the owner's computer.",
  }),
  allowWrite: Type.Optional(
    Type.Boolean({ description: "run: send a flow that changes something on the site." }),
  ),
  targetId: Type.Optional(Type.String({ description: "save: the tab the task ran in." })),
  profile: Type.Optional(Type.String()),
});

export const BROWSER_FLOW_TOOL_DESCRIPTION = [
  "Saved flows replay a site's data request without driving the page, returning only the records and fields asked for.",
  "The browser tool's open and navigate list a site's flows; when one fits the task, use op=run with name, params (the new values), where, select and limit instead of the page.",
  "After a task you will repeat on a site (a search, a list, a lookup), save it: op=save on the same tab with name, params (each value you typed or picked) and description; output picks another candidate request from the result.",
  "A run sends no cookies directly, falls back to the tab's page when that tab is on the site, and remembers what worked.",
  "A flow that changes something on the site runs only with allowWrite=true, once; after outcome_unknown check the site before running it again.",
  'via="device" sends it from the owner\'s computer when this server is refused.',
  "drift or verified=false means the site changed: use the page and save again.",
].join(" ");

/** The browser tool call that runs one browser_flow call. */
export function browserFlowToBrowserArgs(args: Record<string, unknown>): Record<string, unknown> {
  const op = typeof args.op === "string" ? args.op.trim() : "";
  if (!(OPS as readonly string[]).includes(op)) {
    throw new Error("op must be save, run, list or delete");
  }
  const { op: _op, limit, targetId, profile, ...flow } = args;
  return {
    action: `flow_${op}`,
    flow,
    ...(limit !== undefined ? { limit } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
    ...(profile !== undefined ? { profile } : {}),
  };
}
