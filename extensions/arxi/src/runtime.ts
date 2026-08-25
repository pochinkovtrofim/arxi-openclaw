import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setArxiRuntime, getRuntime: getArxiRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "arxi",
    errorMessage: "Arxi channel runtime not initialized",
  });
export { setArxiRuntime, getArxiRuntime };
