import { z } from "zod";

const boundedMcpIdentityStringSchema = z.string().trim().min(1).max(512);

export const cronScheduledMcpToolBindingSchema = z
  .object({
    name: boundedMcpIdentityStringSchema.transform((value) => value.toLowerCase()),
    serverName: boundedMcpIdentityStringSchema,
    operation: z.enum(["tool", "resources_list", "resources_read", "prompts_list", "prompts_get"]),
    toolName: boundedMcpIdentityStringSchema,
  })
  .strict();
