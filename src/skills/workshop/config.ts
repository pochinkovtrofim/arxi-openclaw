import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillsWorkshopAutonomousMode } from "../../config/types.skills.js";

/** Runtime configuration for Skill Workshop. */
type SkillWorkshopConfig = {
  autonomous: {
    mode: SkillsWorkshopAutonomousMode;
    /** Background review model as provider and model id; applies to turns on that provider. */
    model?: { provider: string; model: string };
  };
  maxSkillBytes: number;
};

export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = asNullableRecord(config?.skills?.workshop) ?? {};
  const autonomous = asNullableRecord(raw.autonomous);
  const mode = autonomous?.mode;
  const modelRef = typeof autonomous?.model === "string" ? autonomous.model.trim() : "";
  const slash = modelRef.indexOf("/");
  const maxSkillBytes = raw.maxSkillBytes;
  return {
    autonomous: {
      mode: mode === "off" || mode === "auto" ? mode : "auto",
      ...(slash > 0 && slash < modelRef.length - 1
        ? { model: { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) } }
        : {}),
    },
    maxSkillBytes:
      typeof maxSkillBytes === "number" && Number.isFinite(maxSkillBytes)
        ? Math.min(Math.max(Math.trunc(maxSkillBytes), 1024), 200_000)
        : 40_000,
  };
}
