import { describe, expect, it } from "vitest";
import { createCodeModeCatalogBindings } from "./code-mode-catalog.js";
import type { CatalogSource } from "./tool-search-types.js";

const entry = (id: string, source: CatalogSource = "openclaw") => ({
  id,
  source,
  name: id.split(":").at(-1)!,
  description: id,
});

const names = (bindings: ReturnType<typeof createCodeModeCatalogBindings>) =>
  Object.fromEntries(
    bindings.map((binding) => [
      binding.id,
      binding.aliases ? [binding.callableName, ...binding.aliases] : binding.callableName,
    ]),
  );

describe("Code Mode callable names", () => {
  it("names the core shell `shell` with `exec` as its only alias", () => {
    expect(
      names(
        createCodeModeCatalogBindings([
          entry("openclaw:core:exec"),
          entry("openclaw:core:process"),
          entry("openclaw:core:web_fetch"),
        ]),
      ),
    ).toEqual({
      "openclaw:core:exec": ["shell", "exec"],
      "openclaw:core:process": "process",
      "openclaw:core:web_fetch": "web_fetch",
    });
  });

  it("keeps `shell` for the core shell when a plugin tool is also named shell", () => {
    expect(
      names(
        createCodeModeCatalogBindings([
          entry("openclaw:some-plugin:shell"),
          entry("openclaw:core:exec"),
        ]),
      ),
    ).toEqual({
      "openclaw:core:exec": ["shell", "exec"],
      "openclaw:some-plugin:shell": expect.stringMatching(/^shell_[0-9a-f]{8,}$/u),
    });
  });

  it("leaves a client tool that shadows `exec` under its own name, without an alias", () => {
    expect(
      names(
        createCodeModeCatalogBindings([
          entry("openclaw:core:exec"),
          entry("client:core:exec", "client"),
        ]),
      ),
    ).toEqual({ "client:core:exec": "exec" });
  });
});
