export type PluginHookToolAuthority = {
  /** Opaque host fingerprint for the exact turn, route, policy, and active tool surface. */
  readonly fingerprint: string;
  /** Checks whether the finalized turn surface contains this exact tool. */
  allows(toolName: string): boolean;
  /** Rejects retained or timed-out capabilities after the host dispatch closes. */
  assertActive(): void;
};

/** Native host context supplied only to authorized personal source hooks. */
export type PluginHookPersonalContext = {
  /** Native registrar available only to currently authorized source-reading hooks. */
  memoryArtifactSources?: Readonly<{
    register(input: {
      refs: readonly { ownerId: string; value: string }[];
      complete: boolean;
    }): void;
  }>;
  /**
   * Native USER/MEMORY content that this selected model will receive. Available
   * during before_prompt_build only. Exact token counts and conservative UTF-8
   * upper bounds are distinct contracts and must not share a receipt label.
   */
  personalPrompt?: Readonly<{
    legacySegments: readonly Readonly<{
      name: "USER.md" | "MEMORY.md";
      path: string;
      text: string;
      sha256: string;
      mandatory: true;
    }>[];
    countInputTokens?: (input: { instructions: string; prompt: string }) => Promise<number>;
    countInputUtf8UpperBound?: (input: { instructions: string; prompt: string }) => number;
    /**
     * Declare only reviewed, artifact-owned static policy appended by this hook.
     * Never register source data, owner preferences or mandatory personal files.
     * The native final gate verifies its exact presence separately from personal data.
     */
    registerStaticPolicy?: (policy: { id: string; text: string }) => void;
    /** Register the exact packet text for a provider-bound combined budget gate. */
    registerPreparedPacket?: (packet: {
      text: string;
      budgetTokens: number;
      /** The preparation could not retain its mandatory personal sources. */
      needsExpansion?: boolean;
      expansionReason?: "complex_source_read";
      sourceRefs?: readonly { kind: string; sha256: string }[];
    }) => void;
  }>;
};
