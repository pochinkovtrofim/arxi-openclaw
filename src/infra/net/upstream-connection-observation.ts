import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { buildConnector, Dispatcher } from "undici";
import { loadUndiciModule } from "./undici-dispatcher-options.js";
import { withUndiciErrorDiagnostics } from "./undici-error-diagnostics.js";

/** Content-free transport fact for one pooled request. */
export type UpstreamConnection = {
  /** True when the request was written to an already connected upstream socket. */
  reused: boolean;
  /** Tunnel plus TLS setup time of the socket opened for this request. */
  connectMs?: number;
};

type Observation = { connection?: UpstreamConnection };

const current = new AsyncLocalStorage<Observation>();

/** Runs one request and reports which observed origin socket carried it, if any. */
export async function observeUpstreamConnection<T>(
  run: () => Promise<T>,
): Promise<{ result: T; connection?: UpstreamConnection }> {
  const observation: Observation = {};
  const result = await current.run(observation, run);
  return { result, connection: observation.connection };
}

/**
 * Undici origin factory whose clients record socket reuse and connect time.
 * Observation only: dispatch, connect and their failures are passed through unchanged.
 */
export function createObservedOriginDispatcher(origin: string | URL, options: object): Dispatcher {
  const { Client, Pool } = loadUndiciModule(["Client", "Pool"]);
  const createClient = (clientOrigin: string | URL, clientOptions: object): Dispatcher => {
    // SAFETY: undici Pool normalizes `connect` to a connector before calling its factory.
    const connect = Reflect.get(clientOptions, "connect") as buildConnector.connector;
    let socket: Socket | undefined;
    let waiting: UpstreamConnection | undefined;
    const observedConnect: buildConnector.connector = (connectOptions, callback) => {
      const startedAt = performance.now();
      const connection = waiting;
      waiting = undefined;
      connect(connectOptions, (...result) => {
        const connected = result[1];
        if (connected) {
          socket = connected;
          connected.once("close", () => {
            if (socket === connected) {
              socket = undefined;
            }
          });
          if (connection) {
            connection.connectMs = Math.round(performance.now() - startedAt);
          }
        }
        callback(...result);
      });
    };
    const client = withUndiciErrorDiagnostics(
      new Client(clientOrigin, {
        ...clientOptions,
        connect: observedConnect,
        // SAFETY: Pool passes its own validated Client options; only `connect` is replaced.
      } as ConstructorParameters<typeof Client>[1]),
    );
    const dispatch = client.dispatch.bind(client);
    client.dispatch = (request, handler) => {
      const observation = current.getStore();
      if (observation && !observation.connection) {
        // Undici writes a request to this client's live socket, or connects first.
        const reused = Boolean(socket && !socket.destroyed);
        observation.connection = { reused };
        if (!reused) {
          waiting = observation.connection;
        }
      }
      return dispatch(request, handler);
    };
    return client;
  };
  return withUndiciErrorDiagnostics(
    new Pool(origin, {
      ...options,
      factory: createClient,
      // SAFETY: Agent passes its own validated Pool options; only `factory` is replaced.
    } as ConstructorParameters<typeof Pool>[1]),
  );
}
