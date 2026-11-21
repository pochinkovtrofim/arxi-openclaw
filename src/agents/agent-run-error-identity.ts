/**
 * A failed run's error identity: what kind of error ended it and where it was
 * thrown, never its text. Run errors can carry model output, tool results or
 * the owner's words, so an operator outside the VM gets only bounded tokens
 * (an error kind, a constructor name, a code, a source file and line). Without
 * them an error no fixed phrase names is "unlisted" and cannot be diagnosed
 * (Ro production 2026-11-20: six messages lost to errors nobody could name).
 */
export type AgentRunErrorIdentity = {
  /** The run result's own error kind, such as compaction_failure. */
  kind?: string;
  /** The thrown value's constructor name, such as TypeError. */
  name?: string;
  /** The error's code, such as ENOENT or a failover code. */
  code?: string;
  /** Where it was thrown: the first stack frame outside node_modules, as file:line. */
  origin?: string;
  /** The same three facts for the error's direct cause. */
  causeName?: string;
  causeCode?: string;
  causeOrigin?: string;
  /** Redacted provider facts the run already observed. */
  failoverReason?: string;
  providerRuntimeFailureKind?: string;
  providerErrorType?: string;
  httpStatus?: number;
};

const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const FIELDS = [
  "kind",
  "name",
  "code",
  "origin",
  "causeName",
  "causeCode",
  "causeOrigin",
  "failoverReason",
  "providerRuntimeFailureKind",
  "providerErrorType",
] as const;

function token(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The first stack frame in the program's own code, as basename:line. */
export function errorOrigin(stack: unknown): string | undefined {
  if (typeof stack !== "string") {
    return undefined;
  }
  for (const line of stack.split("\n").slice(1, 40)) {
    // "at fn (/path/file.js:12:3)", "at /path/file.js:12:3", "at file:///path/file.js:12:3"
    const frame = /(?:\(|at )((?:file:\/\/)?[^\s()]+?):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!frame) {
      continue;
    }
    const file = frame[1];
    const lineNumber = frame[2];
    if (!file || !lineNumber) {
      continue;
    }
    if (file.startsWith("node:") || file.includes("/node_modules/") || file.includes("\\node_modules\\")) {
      continue;
    }
    const base = file.split(/[\\/]/).pop() ?? "";
    return token(`${base}:${lineNumber}`);
  }
  return undefined;
}

function thrownFacts(value: unknown): { name?: string; code?: string; origin?: string } {
  if (!(value instanceof Error)) {
    return {};
  }
  const code = (value as { code?: unknown }).code;
  return {
    name: token(value.name) ?? token(value.constructor?.name),
    code: token(typeof code === "number" ? String(code) : code),
    origin: errorOrigin(value.stack),
  };
}

/**
 * Builds the identity from what a run's lifecycle holds when it fails: the
 * thrown value (if any), the result's error kind and the redacted provider
 * observation. Text is dropped: every field must be a bounded token.
 */
export function describeAgentRunErrorIdentity(params: {
  error?: unknown;
  kind?: unknown;
  failoverCode?: unknown;
  observation?: unknown;
}): AgentRunErrorIdentity | undefined {
  const thrown = thrownFacts(params.error);
  const cause = thrownFacts(params.error instanceof Error ? params.error.cause : undefined);
  const observation = record(params.observation);
  return normalizeAgentRunErrorIdentity({
    kind: params.kind,
    name: thrown.name,
    code: thrown.code ?? params.failoverCode,
    origin: thrown.origin,
    causeName: cause.name,
    causeCode: cause.code,
    causeOrigin: cause.origin,
    failoverReason: observation?.failoverReason,
    providerRuntimeFailureKind: observation?.providerRuntimeFailureKind,
    providerErrorType: observation?.providerErrorType,
    httpStatus: observation?.httpStatus,
  });
}

/** Rejects malformed lifecycle input and keeps only bounded tokens. */
export function normalizeAgentRunErrorIdentity(value: unknown): AgentRunErrorIdentity | undefined {
  const source = record(value);
  if (!source) {
    return undefined;
  }
  const identity: AgentRunErrorIdentity = {};
  for (const field of FIELDS) {
    const kept = token(source[field]);
    if (kept) {
      identity[field] = kept;
    }
  }
  const status = source.httpStatus;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    identity.httpStatus = status;
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
}
