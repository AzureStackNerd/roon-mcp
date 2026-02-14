#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { roonConnection } from "./roon-connection.js";
import { registerZoneTools } from "./tools/zone.js";
import { registerPlaybackTools } from "./tools/playback.js";
import { registerVolumeTools } from "./tools/volume.js";
import { registerBrowseTools } from "./tools/browse.js";

const server = new McpServer({
  name: "roon-mcp",
  version: "1.0.0",
});

registerZoneTools(server);
registerPlaybackTools(server);
registerVolumeTools(server);
registerBrowseTools(server);

async function main(): Promise<void> {
  // Start Roon connection (runs in background with auto-reconnect)
  roonConnection.connect();

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[roon-mcp] MCP server running on stdio");
}

main().catch((error) => {
  console.error("[roon-mcp] Fatal error:", error);
  process.exit(1);
});
