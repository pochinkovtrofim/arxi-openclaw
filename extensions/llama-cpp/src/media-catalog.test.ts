import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlamaCppHardware } from "./hardware.js";
import {
  LLAMA_CPP_MEDIA_RECIPES,
  recommendLlamaCppMedia,
  resolveLlamaCppMediaArtifact,
} from "./media-catalog.js";

const runtimeBuild = vi.hoisted(() => ({ value: 10_809 }));
// The recipes are verified on llama.cpp b10809. The fork pins a newer build,
// which keeps local media unavailable until the recipes are verified on it; the
// budget cases run on the verified runtime.
vi.mock("./llama-server-assets.js", async (original) => ({
  ...(await original<typeof import("./llama-server-assets.js")>()),
  get LLAMA_SERVER_BUILD() {
    return runtimeBuild.value;
  },
}));

const GIB = 1024 ** 3;

beforeEach(() => {
  runtimeBuild.value = 10_809;
});

function hardware(overrides: Partial<LlamaCppHardware> = {}): LlamaCppHardware {
  return {
    platform: "linux",
    arch: "x64",
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 7 * GIB,
    availableDiskBytes: 100 * GIB,
    availableRuntimeDiskBytes: 100 * GIB,
    sharedDisk: true,
    accelerator: { kind: "cpu", reason: "CPU host" },
    ...overrides,
  };
}

describe("managed local media catalog", () => {
  it("pins every model and matching projector to immutable verified downloads", () => {
    expect(new Set(LLAMA_CPP_MEDIA_RECIPES.map((recipe) => recipe.capability))).toEqual(
      new Set(["ocr", "vision"]),
    );
    for (const recipe of LLAMA_CPP_MEDIA_RECIPES) {
      expect(recipe.projector.repository).toBe(recipe.model.repository);
      expect(recipe.projector.revision).toBe(recipe.model.revision);
      for (const artifact of [recipe.model, recipe.projector]) {
        expect(artifact.revision).toMatch(/^[a-f0-9]{40}$/u);
        expect(artifact.expectedSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(artifact.expectedSize).toBeGreaterThan(0);
        expect(artifact.url).toBe(
          `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${artifact.filename}?download=true`,
        );
        expect(resolveLlamaCppMediaArtifact(artifact.source)).toBe(artifact);
        expect(
          resolveLlamaCppMediaArtifact(artifact.source.replace(artifact.revision, "main")),
        ).toBeUndefined();
      }
    }
    expect(resolveLlamaCppMediaArtifact("hf:unknown/model/mmproj.gguf")).toBeUndefined();
  });

  it.each([{ host: hardware({ totalMemoryBytes: 4 * GIB }), reason: /total RAM/u }])(
    "rejects incomplete pairs under total and available memory limits",
    ({ host, reason }) => {
      expect(recommendLlamaCppMedia(host)).toMatchObject({
        kind: "unavailable",
        reason: expect.stringMatching(reason),
      });
    },
  );

  it("charges separate volumes separately and shared capacity only once", () => {
    const host = hardware({
      availableDiskBytes: 3 * GIB,
      availableRuntimeDiskBytes: 2 * GIB,
      sharedDisk: false,
    });
    expect(recommendLlamaCppMedia(host)).toMatchObject({
      kind: "recommended",
    });
    expect(recommendLlamaCppMedia({ ...host, sharedDisk: true }).kind).toBe("unavailable");
    expect(recommendLlamaCppMedia({ ...host, availableRuntimeDiskBytes: GIB })).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("runtime directory"),
    });
  });

  it("credits verified models and projectors independently on retry", () => {
    const initial = recommendLlamaCppMedia(hardware());
    if (initial.kind !== "recommended") {
      throw new Error(initial.reason);
    }
    const artifacts = [
      initial.ocr.model,
      initial.ocr.projector,
      initial.vision.model,
      initial.vision.projector,
    ];
    const artifactSha256 = new Set(artifacts.map((artifact) => artifact.expectedSha256));
    const host = hardware({ availableDiskBytes: 1024 ** 2, availableRuntimeDiskBytes: 1024 ** 2 });
    expect(recommendLlamaCppMedia(host, { artifactSha256, runtime: true })).toMatchObject({
      kind: "recommended",
      requiredDiskBytes: 0,
    });
    artifactSha256.delete(initial.vision.projector.expectedSha256);
    expect(recommendLlamaCppMedia(host, { artifactSha256, runtime: true }).kind).toBe(
      "unavailable",
    );
    expect(recommendLlamaCppMedia(hardware(), { artifactSha256, runtime: true })).toMatchObject({
      kind: "recommended",
      requiredDiskBytes: initial.vision.projector.expectedSize,
    });
    expect(recommendLlamaCppMedia(host, { artifactSha256 }).kind).toBe("unavailable");
  });

  it("keeps local media unavailable on the pinned runtime the recipes were not verified on", async () => {
    const { LLAMA_SERVER_BUILD } = await vi.importActual<typeof import("./llama-server-assets.js")>(
      "./llama-server-assets.js",
    );
    runtimeBuild.value = LLAMA_SERVER_BUILD;
    expect(recommendLlamaCppMedia(hardware())).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining(
        `requires verified llama.cpp build 10809; available build is ${LLAMA_SERVER_BUILD}`,
      ),
    });
  });

  it("does not guess when runtime free space is unknown", () => {
    expect(
      recommendLlamaCppMedia(hardware({ availableRuntimeDiskBytes: undefined })),
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("permissions"),
    });
  });
});
