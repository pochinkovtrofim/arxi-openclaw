import { FAILOVER_REASONS } from "../../packages/gateway-protocol/src/failover-reasons.js";
import { resolveGlobalSingleton } from "./global-singleton.js";
import { FIXED_USER_MESSAGE_CODES } from "./user-message-codes.js";
import type { UserMessageEvent } from "./user-message.types.js";

type UserMessageRenderer = (event: UserMessageEvent) => string | undefined;

// Only a dispatch bridge: the hook runner owns registry selection and request scope.
// Keeping the bridge here lets early error paths stay independent of plugin loading.
const state = resolveGlobalSingleton<{ render?: UserMessageRenderer }>(
  Symbol.for("openclaw.userMessageRenderer"),
  () => ({}),
);

export function setUserMessageRenderer(render: UserMessageRenderer | undefined): void {
  state.render = render;
}

export function resolveUserMessage(event: UserMessageEvent): string | undefined {
  return state.render?.(event);
}

export function renderUserMessage(event: UserMessageEvent, fallback: string): string {
  return resolveUserMessage(event) ?? fallback;
}

/**
 * The rendered copy of every user message without parameters. A worker thread
 * has its own globals and no hook runner, so history it projects there would
 * show the built-in fallback instead of the copy the owner's channel sends.
 */
export type UserMessageCopy = Readonly<Record<string, string>>;

const FIXED_CODES: ReadonlySet<string> = new Set(FIXED_USER_MESSAGE_CODES);

function userMessageCopyKey(event: UserMessageEvent): string | undefined {
  if (event.code === "assistant_request_failure") {
    return `${event.code}:${event.reason}`;
  }
  return FIXED_CODES.has(event.code) ? event.code : undefined;
}

/** Renders the parameter-free messages with the current hook, in the reader's language. */
export function captureUserMessageCopy(): UserMessageCopy | undefined {
  const render = state.render;
  if (!render) {
    return undefined;
  }
  const copy: Record<string, string> = {};
  const add = (event: UserMessageEvent) => {
    const key = userMessageCopyKey(event);
    const text = render(event);
    if (key && text !== undefined) {
      copy[key] = text;
    }
  };
  for (const code of FIXED_USER_MESSAGE_CODES) {
    add({ code });
  }
  for (const reason of FAILOVER_REASONS) {
    add({ code: "assistant_request_failure", reason });
  }
  return copy;
}

/** Lets a thread without the hook runner render what the main thread captured. */
export function installUserMessageCopy(copy: UserMessageCopy | undefined): void {
  if (!copy) {
    return;
  }
  state.render = (event) => {
    const key = userMessageCopyKey(event);
    return key === undefined ? undefined : copy[key];
  };
}
