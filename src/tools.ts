// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";

import { configurePipelineTools } from "./tools/pipelines.js";
import { configureCoreTools } from "./tools/core.js";
import { configureRepoTools } from "./tools/repositories.js";
import { configureSearchTools } from "./tools/search.js";
import { configureTestPlanTools } from "./tools/test-plans.js";
import { configureWikiTools } from "./tools/wiki.js";
import { configureWorkTools } from "./tools/work.js";
import { configureWorkItemTools } from "./tools/work-items.js";

function configureAllTools(server: McpServer, tokenProvider: () => Promise<string>, connectionProvider: () => Promise<WebApi>, userAgentProvider: () => string) {
  configureCoreTools(server, tokenProvider, connectionProvider, userAgentProvider);
  configureWorkTools(server, tokenProvider, connectionProvider);
  configurePipelineTools(server, tokenProvider, connectionProvider, userAgentProvider);
  configureRepoTools(server, tokenProvider, connectionProvider, userAgentProvider);
  configureWorkItemTools(server, tokenProvider, connectionProvider, userAgentProvider);
  configureWikiTools(server, tokenProvider, connectionProvider, userAgentProvider);
  configureTestPlanTools(server, tokenProvider, connectionProvider, userAgentProvider);
  configureSearchTools(server, tokenProvider, connectionProvider, userAgentProvider);
}

export { configureAllTools };
