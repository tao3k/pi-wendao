declare module "@tintinweb/pi-subagents/dist/index.js" {
  import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

  export default function registerPiSubagents(pi: ExtensionAPI): void;
}
