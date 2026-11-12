import { formatErrorMessage } from "../../../infra/errors.js";
import type { Model } from "../../../llm/types.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { getApiKeyForModelCore, type ResolvedProviderAuth } from "../../model-auth.js";
import { clampRuntimeAuthRefreshDelayMs } from "../../runtime-auth-refresh.js";
import {
  RUNTIME_AUTH_REFRESH_MARGIN_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
  type RuntimeAuthState,
} from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/**
 * A run resolves its credential once and reuses it for every model call, so an OAuth
 * login can expire in the middle of a long turn and the provider refuses the next call
 * although the login is fine (production 2026-11-09). The run renews it before expiry
 * from the start of its attempts until it settles, and once more on such a refusal.
 */
export function createEmbeddedOAuthLoginRenewal(params: {
  config: RunEmbeddedAgentParams["config"];
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  authStorage: { setRuntimeApiKey(provider: string, apiKey: string): void };
  state: {
    readonly models: { runtime: Model };
    apiKeyInfo: ResolvedProviderAuth | null;
    runtimeAuthState: RuntimeAuthState | null;
  };
  log: { warn(message: string): void };
}) {
  const { state } = params;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  const clear = () => clearTimeout(timer);

  /** Renews the active OAuth login through its refresh path; false when the run moved on. */
  const renew = async (): Promise<boolean> => {
    const info = state.apiKeyInfo;
    if (info?.mode !== "oauth" || !info.profileId || state.runtimeAuthState) {
      return false;
    }
    const runtimeModel = state.models.runtime;
    const renewed = await getApiKeyForModelCore({
      model: runtimeModel,
      cfg: params.config,
      profileId: info.profileId,
      store: params.authStore,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      lockedProfile: true,
      secretSentinels: true,
      forceRefresh: true,
      includeOAuthExpiry: true,
    });
    if (!armed) {
      return false;
    }
    if (state.apiKeyInfo !== info) {
      // Another renewal of the same login may have won the refresh queue.
      return state.apiKeyInfo?.mode === "oauth" && state.apiKeyInfo.profileId === info.profileId;
    }
    if (renewed.mode !== "oauth" || !renewed.apiKey) {
      return false;
    }
    state.apiKeyInfo = renewed;
    params.authStorage.setRuntimeApiKey(runtimeModel.provider, renewed.apiKey);
    return true;
  };

  const schedule = (minDelayMs: number): void => {
    clear();
    const expires = state.apiKeyInfo?.mode === "oauth" ? state.apiKeyInfo.expires : undefined;
    if (!armed || state.runtimeAuthState || expires === undefined) {
      return;
    }
    timer = setTimeout(
      () => {
        renew().then(
          () => schedule(RUNTIME_AUTH_REFRESH_RETRY_MS),
          (error: unknown) => {
            params.log.warn(`OAuth login renewal failed: ${formatErrorMessage(error)}`);
            schedule(RUNTIME_AUTH_REFRESH_RETRY_MS);
          },
        );
      },
      clampRuntimeAuthRefreshDelayMs({
        refreshAt: expires - RUNTIME_AUTH_REFRESH_MARGIN_MS,
        now: Date.now(),
        minDelayMs,
      }),
    );
    timer.unref?.();
  };

  return {
    clear,
    renew,
    schedule,
    /** Keeps the OAuth login fresh until stop settles the run. */
    start: (): void => {
      armed = true;
      schedule(RUNTIME_AUTH_REFRESH_MIN_DELAY_MS);
    },
    stop: (): void => {
      armed = false;
      clear();
    },
    /** After a provider refused the login: true renewed, false failed, undefined not applicable. */
    renewAfterAuthError: async (signal: AbortSignal): Promise<boolean | undefined> => {
      if (state.runtimeAuthState) {
        return undefined;
      }
      try {
        if (await renew()) {
          schedule(RUNTIME_AUTH_REFRESH_RETRY_MS);
          return true;
        }
        return undefined;
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        params.log.warn(
          `OAuth login renewal after an auth error failed: ${formatErrorMessage(error)}`,
        );
        return false;
      }
    },
  };
}
