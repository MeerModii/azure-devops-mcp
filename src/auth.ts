// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { logger } from "./logger.js";
function createAuthenticator(): () => Promise<string> {
  logger.debug("Authenticator: Using PAT authentication (PERSONAL_ACCESS_TOKEN)");
  return async () => {
    logger.debug("pat: Reading token from PERSONAL_ACCESS_TOKEN environment variable");
    const b64Pat = process.env["PERSONAL_ACCESS_TOKEN"];
    if (!b64Pat) {
      logger.error("pat: PERSONAL_ACCESS_TOKEN environment variable is not set or empty");
      throw new Error("Environment variable 'PERSONAL_ACCESS_TOKEN' is not set or empty. Please set it with a valid base64-encoded Azure DevOps Personal Access Token.");
    }
    return b64Pat;
  };
}
export { createAuthenticator };
