import { resolveGlobalSingleton } from "./global-singleton.js";
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
