import { Context } from '@deepseek-ai/cordis'
import * as mcpPlugin from '@deepseek-ai/dsh-mcp-client'
import { McpTransportDescriptor } from '@dolphinminer/dsh-desktop-protocol'

import { McpMountFactory, McpMountHandle } from './mcp-supervisor.js'

export class CordisMcpMountFactory implements McpMountFactory {
  constructor(private readonly ctx: Context) {}

  async mount(transport: McpTransportDescriptor): Promise<McpMountHandle> {
    const config: mcpPlugin.Config = transport.transport === 'streamable-http'
      ? {
          transport: 'streamable-http',
          serverName: transport.serverName,
          url: transport.url,
          headers: {},
          toolCallTimeoutMs: 60_000,
          failOnStartupError: true,
          reconnect: {
            enabled: true,
            initialDelayMs: 1_000,
            maxDelayMs: 30_000,
            maxAttempts: 10,
          },
        }
      : {
          transport: 'stdio',
          serverName: transport.serverName,
          command: transport.command,
          args: transport.args,
          env: transport.env,
          cwd: transport.cwd,
          toolCallTimeoutMs: 60_000,
          failOnStartupError: true,
          reconnect: {
            enabled: true,
            initialDelayMs: 1_000,
            maxDelayMs: 30_000,
            maxAttempts: 10,
          },
        }
    const fiber = this.ctx.plugin(mcpPlugin, config)
    await fiber
    return {
      serverName: transport.serverName,
      toolNames: () => this.ctx.tools.schemas()
        .map(schema => schema.name)
        .filter(name => name.startsWith(`mcp__${transport.serverName}__`)),
      dispose: fiber.dispose,
    }
  }
}
