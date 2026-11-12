import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";

/** Pins a tool caller's Gateway context to the request admitted when the caller was bound. */
export function bindGatewayToolContextResolver(
  resolveGatewayContext: GatewayContextResolver | undefined,
): GatewayContextResolver | undefined {
  if (!resolveGatewayContext) {
    return undefined;
  }
  let admittedContext: GatewayRequestContext | undefined;
  try {
    admittedContext = resolveGatewayContext();
  } catch {
    return () => undefined;
  }
  if (!admittedContext) {
    return () => undefined;
  }
  const resolveAdmittedContext = () => {
    try {
      return resolveGatewayContext() === admittedContext ? admittedContext : undefined;
    } catch {
      return undefined;
    }
  };
  bindGatewayContextResolver(resolveAdmittedContext, admittedContext.resolveGatewayContext);
  return resolveAdmittedContext;
}
