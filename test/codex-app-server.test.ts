import { describe, expect, test } from "bun:test";
import { appServerArgv } from "../server/codexAppServer";

describe("appServerArgv", () => {
  test("resolves Codex to an executable path for background services", () => {
    const argv = appServerArgv(null);

    expect(argv[0]).toBe("/usr/bin/env");
    expect(argv[1]).toContain("codex");
    expect(argv.slice(2)).toEqual(["app-server"]);
  });
});
