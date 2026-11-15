import { describe, expect, it } from "vitest";
import * as core from "@mail-mcp/core";
import { createRequire } from "node:module";

describe("debug module resolution", () => {
  it("shows what vitest resolves", () => {
    const require_ = createRequire(import.meta.url);
    let resolved = "unknown";
    try {
      resolved = require_.resolve("@mail-mcp/core");
    } catch {
      resolved = "unresolvable via require (aliased)";
    }
    console.log("require.resolve:", resolved);
    console.log("has parseCapabilityLine:", typeof core.parseCapabilityLine);
    console.log("has isSieveBye:", typeof core.isSieveBye);
    console.log("has sieveScriptsListSchema:", typeof core.sieveScriptsListSchema);
    console.log("CAPABILITY test:", JSON.stringify(core.parseCapabilityLine('* CAPABILITY "SIEVE" "FILEINTO" "VACATION"')));
    console.log("tagged test:", JSON.stringify(core.sieveTaggedMessage('NO (AUTHFAILED) "bad credentials"')));
    expect(true).toBe(true);
  });
});
