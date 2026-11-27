const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';
const MCP_MANAGER = '@deepseek-ai/dsh-mcp-manager';
/** Server names DSH accepts for MCP clients; reused for prompt-section names. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** Identify a tool's registering plugin from its Cordis Loader context. */
export function providerFromContext(ctx, scope, toolName) {
  const fiber = ctx?.fiber;
  const entry = fiber?.entry || ctx?.[Symbol.for('cordis.entry')];
  const configuredModule = typeof entry?.options?.name === 'string' ? entry.options.name : '';
  // McpManager mounts a client fiber directly, without a separate Loader entry.
  const managedClient = fiber?.runtime?.name === 'mcp-client'
    && (configuredModule === '' || configuredModule === MCP_MANAGER);
  const module = managedClient ? MCP_CLIENT : configuredModule;
  if (module === '' || module.startsWith('cordis:')) return null;
  const match = module.match(/^(@[^/]+\/[^/]+|[^./\\:][^/\\:]*)(?:\/|$)/);
  const plugin = match === null ? module : match[1];
  const baseUrl = entry?.parent?.tree?.ctx?.baseUrl ?? ctx?.baseUrl;
  const provider = { plugin, module, official: plugin.startsWith('@deepseek-ai/'), baseUrl };
  if (scope === undefined && plugin === MCP_CLIENT) {
    const serverName = fiber?.config?.serverName ?? entry?.options?.config?.serverName;
    if (typeof serverName === 'string' && MCP_SERVER_NAME.test(serverName)
      && typeof toolName === 'string' && toolName.startsWith(`mcp__${serverName}__`)) {
      provider.mcpServer = serverName;
    }
  }
  return provider;
}

/** Stable automatic group identities are independent of tool names and registration order. */
export function providerGroup(provider) {
  if (provider === null || provider === undefined || typeof provider.plugin !== 'string' || provider.plugin === '') {
    return { id: '@unknown', label: 'Unknown provider', kind: 'unknown' };
  }
  if (typeof provider.mcpServer === 'string' && MCP_SERVER_NAME.test(provider.mcpServer)) {
    return { id: `@mcp/${provider.mcpServer}`, label: provider.mcpServer, kind: 'mcp' };
  }
  if (provider.official === true) return { id: '@official', label: 'Official tools', kind: 'official' };
  return { id: `@plugin/${provider.plugin}`, label: provider.plugin, kind: 'plugin' };
}
