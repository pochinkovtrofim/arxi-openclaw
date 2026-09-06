/**
 * SSRF policy helpers re-exported for Browser network/navigation guards.
 */
export {
  SsrFBlockedError,
  assertHostnameAllowedWithPolicy,
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../../sdk-security-runtime.js";
