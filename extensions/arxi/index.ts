import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "arxi",
  name: "Arxi",
  description: "Private owner channel through the Arxi host boundary",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "arxiPlugin" },
  runtime: { specifier: "./api.js", exportName: "setArxiRuntime" },
});
