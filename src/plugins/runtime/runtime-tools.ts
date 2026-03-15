import {
  createMemoryGetTool,
  createMemorySearchTool,
  createMemoryUsefulTool,
} from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createMemoryGetTool,
    createMemorySearchTool,
    createMemoryUsefulTool,
    registerMemoryCli,
  };
}
