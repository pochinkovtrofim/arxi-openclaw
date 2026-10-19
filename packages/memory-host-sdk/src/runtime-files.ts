// Focused runtime contract for memory file/backend access.

export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  MemoryEntryProvenance,
  MemorySearchPhaseTiming,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
} from "./host/types.js";
