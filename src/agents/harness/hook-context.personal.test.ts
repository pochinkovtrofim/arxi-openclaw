import { expect, it } from "vitest";
import { buildAgentHookContext } from "./hook-context.js";

it("forwards the selected Codex personal source registrar to before_prompt_build", () => {
  let registered = "";
  const personalPrompt = {
    legacySegments: [
      {
        name: "USER.md" as const,
        path: "/owner/USER.md",
        text: "Owner context",
        sha256: "source-digest",
        mandatory: true as const,
      },
    ],
    countInputUtf8UpperBound: ({
      instructions,
      prompt,
    }: {
      instructions: string;
      prompt: string;
    }) => Buffer.byteLength(`${instructions}\n\n${prompt}`),
    registerPreparedPacket: ({ text }: { text: string; budgetTokens: number }) => {
      registered = text;
    },
  };
  const context = buildAgentHookContext({ personalPrompt });
  expect(context.personalPrompt).toBe(personalPrompt);
  context.personalPrompt?.registerPreparedPacket?.({ text: "packet", budgetTokens: 8000 });
  expect(registered).toBe("packet");
});
