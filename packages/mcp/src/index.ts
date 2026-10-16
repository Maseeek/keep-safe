#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuredClient } from './client.js';
import { createMcpServer } from './server.js';

try {
  const server = createMcpServer(await configuredClient());
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`Keep Safe MCP: ${error instanceof Error ? error.message : 'Startup failed.'}\n`);
  process.exitCode = 1;
}
