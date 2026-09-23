import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createOctenWebSearchProvider } from "./src/octen-web-search-provider.js";

export default definePluginEntry({
  id: "octen",
  name: "Octen Plugin",
  description: "Bundled Octen web search plugin",
  register(api) {
    api.registerWebSearchProvider(createOctenWebSearchProvider());
  },
});
