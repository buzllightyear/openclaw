import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/memory-core";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryUsefulTool = api.runtime.tools.createMemoryUsefulTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        const tools = [memorySearchTool, memoryGetTool];
        if (memoryUsefulTool) {
          tools.push(memoryUsefulTool);
        }
        return tools;
      },
      { names: ["memory_search", "memory_get", "memory_useful"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
