import { afterEach, describe, expect, it } from "vitest";
import { setActiveNodeContexts } from "../../../infra/active-node-context.js";
import { projectRuntimeContextFragments } from "../../internal-runtime-context.js";
import { buildActiveNodeRuntimeContext } from "./attempt-prompt-build.js";

afterEach(() => setActiveNodeContexts([]));

describe("active computer hint in the per-turn runtime context", () => {
  it("refreshes the pairing fact and renders the current node as runtime instruction text", async () => {
    let prepared = 0;
    setActiveNodeContexts([
      { nodeId: "mac-123", prepare: async () => void prepared++ },
      { nodeId: "person-mac", profileId: "person" },
    ]);

    const owner = await buildActiveNodeRuntimeContext({});
    const person = await buildActiveNodeRuntimeContext({ requesterProfileId: "person" });

    expect(prepared).toBe(1);
    expect(owner).toEqual([
      {
        kind: "runtime-instruction",
        text: "Current active computer (latest reported app/system input, not message origin): active_node=mac-123 active_node_identity=unknown",
      },
    ]);
    expect(person[0]?.text).toContain("active_node=person-mac active_node_identity=requester");
    // Rendered verbatim, so the hint reads exactly as the CLI runner's per-turn text.
    expect(projectRuntimeContextFragments(owner)).toBe(owner[0]!.text);
  });

  it("supersedes a disconnected node with an explicit unknown on the next turn", async () => {
    setActiveNodeContexts([{ nodeId: "mac-123" }]);
    expect((await buildActiveNodeRuntimeContext({}))[0]?.text).toContain("active_node=mac-123");
    setActiveNodeContexts([{ nodeId: "mac-123", isCurrent: () => false }]);
    expect((await buildActiveNodeRuntimeContext({}))[0]?.text).toContain("active_node=unknown");
  });

  it("stays out of raw model runs and settled tool finalization", async () => {
    setActiveNodeContexts([{ nodeId: "mac-123" }]);
    expect(await buildActiveNodeRuntimeContext({ skip: true })).toEqual([]);
  });
});
