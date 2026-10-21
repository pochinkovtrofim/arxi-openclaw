import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillsWorkshopAutonomousMode } from "../../config/types.skills.js";

/** Runtime configuration for Skill Workshop. */
type SkillWorkshopConfig = {
  autonomous: {
    mode: SkillsWorkshopAutonomousMode;
    /** Review route per reviewed turn's provider/model ref, kept within one provider. */
    models: ReadonlyMap<string, { provider: string; model: string }>;
  };
  maxSkillBytes: number;
};

export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = asNullableRecord(config?.skills?.workshop) ?? {};
  const autonomous = asNullableRecord(raw.autonomous);
  const mode = autonomous?.mode;
  const models = new Map<string, { provider: string; model: string }>();
  for (const [from, to] of Object.entries(asNullableRecord(autonomous?.models) ?? {})) {
    const source = splitModelRef(from);
    const target = typeof to === "string" ? splitModelRef(to) : undefined;
    if (source && target && source.provider === target.provider) {
      models.set(`${source.provider}/${source.model}`, target);
    }
  }
  const maxSkillBytes = raw.maxSkillBytes;
  return {
    autonomous: {
      mode: mode === "off" || mode === "auto" ? mode : "auto",
      models,
    },
    maxSkillBytes:
      typeof maxSkillBytes === "number" && Number.isFinite(maxSkillBytes)
        ? Math.min(Math.max(Math.trunc(maxSkillBytes), 1024), 200_000)
        : 40_000,
  };
}

function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1
    ? { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
    : undefined;
}
