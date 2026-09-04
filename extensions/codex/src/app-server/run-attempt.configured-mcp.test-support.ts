import { vi } from "vitest";

type FixtureMock = ReturnType<typeof vi.fn>;

type StaticMcpFixtureState = {
  dispose: FixtureMock;
  materializationOrder: string[];
  staticBaseToolName: string;
  staticCalls: Array<Record<string, unknown>>;
  staticDiagnosticNotice?: string;
  staticFacade: FixtureMock;
  staticFailure?: Error;
  staticFailureGate?: Promise<void>;
  staticHonorToolsAllow: boolean;
  staticProducedToolNames: string[];
  staticToolExecutes: FixtureMock[];
};

type ConfiguredMcpFixtureState = StaticMcpFixtureState & {
  authorityResolvers: unknown[];
  captureCalls: unknown[];
  captureFacade: FixtureMock;
  captureRefs: unknown[];
  ordinaryToolNames: string[];
  requesterCalls: number;
  requesterDiagnosticNotice?: string;
  requesterDispose: FixtureMock;
  requesterParams: Array<Record<string, unknown>>;
  requesterScopedServerNames: string[];
  requesterToolNames: string[];
  threadConfigCalls: Array<Record<string, unknown>>;
  threadConfigFacade: FixtureMock;
};

export function appendOrdinaryDynamicToolFixtures<T>(
  tools: readonly T[],
  names: readonly string[],
) {
  return [
    ...tools,
    ...names.map((name) => ({
      name,
      label: name,
      description: `Ordinary dynamic fixture ${name}`,
      parameters: { type: "object" as const, properties: {} },
      execute: vi.fn(async () => ({ content: [], details: {} })),
    })),
  ];
}

export async function materializeStaticMcpFixture(
  params: Record<string, unknown>,
  state: StaticMcpFixtureState,
) {
  state.materializationOrder.push("static");
  state.staticCalls.push(params);
  state.staticFacade(params);
  if (state.staticFailure) {
    await state.staticFailureGate;
    throw state.staticFailure;
  }
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "initial-result" }],
    details: { status: "ok" },
  }));
  state.staticToolExecutes.push(execute);
  const reservedNames = new Set(
    Array.from((params.reservedToolNames as Iterable<string> | undefined) ?? []).map((name) =>
      name.toLowerCase(),
    ),
  );
  let staticToolName = state.staticBaseToolName;
  for (let suffix = 2; reservedNames.has(staticToolName.toLowerCase()); suffix += 1) {
    staticToolName = `${state.staticBaseToolName}-${suffix}`;
  }
  state.staticProducedToolNames.push(staticToolName);
  const toolsAllow = params.toolsAllow as string[] | undefined;
  const staticToolAllowed =
    !state.staticHonorToolsAllow ||
    !toolsAllow ||
    toolsAllow.includes("*") ||
    toolsAllow.includes(staticToolName);
  return {
    tools:
      state.staticDiagnosticNotice || !staticToolAllowed
        ? []
        : [
            {
              name: staticToolName,
              description: "Show the configured MCP fixture result.",
              parameters: { type: "object", properties: {} },
              execute,
            },
          ],
    appTools: [
      {
        name: "fake__app_only",
        description: "App-view-only configured MCP fixture.",
        parameters: { type: "object", properties: {} },
        execute,
      },
    ],
    mcpNameAllocations: [
      {
        name: staticToolName,
        baseName: state.staticBaseToolName,
        identity: JSON.stringify(["static", "tool", state.staticBaseToolName]),
      },
    ],
    ...(state.staticDiagnosticNotice ? { diagnosticNotice: state.staticDiagnosticNotice } : {}),
    dispose: async () => {
      await state.dispose();
    },
  };
}

export function resetConfiguredMcpFixtureState(state: ConfiguredMcpFixtureState): void {
  state.authorityResolvers.length = 0;
  state.captureCalls.length = 0;
  state.captureRefs.length = 0;
  state.staticCalls.length = 0;
  state.materializationOrder.length = 0;
  state.staticBaseToolName = "fake__show";
  state.staticHonorToolsAllow = false;
  state.staticProducedToolNames.length = 0;
  state.staticToolExecutes.length = 0;
  state.requesterCalls = 0;
  state.requesterParams.length = 0;
  state.requesterScopedServerNames.length = 0;
  state.requesterToolNames.length = 0;
  state.requesterDiagnosticNotice = undefined;
  state.requesterDispose.mockClear();
  state.ordinaryToolNames.length = 0;
  state.threadConfigCalls.length = 0;
  state.staticDiagnosticNotice = undefined;
  state.staticFailure = undefined;
  state.staticFailureGate = undefined;
  state.dispose.mockClear();
  state.captureFacade.mockClear();
  state.staticFacade.mockClear();
  state.threadConfigFacade.mockClear();
}
