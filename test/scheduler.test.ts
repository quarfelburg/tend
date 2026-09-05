import { describe, expect, test } from "bun:test";
import { launchdPlist, launchdPlistPath } from "../server/cli/scheduler";

describe("macOS launchd scheduler", () => {
  test("renders a portable five-minute LaunchAgent", () => {
    const plist = launchdPlist({
      home: "/tmp/tend home",
      cwd: "/opt/tend",
      cliCommand: ["/opt/homebrew/bin/bun", "/opt/tend/tend.ts"],
      apiPort: "4999",
    });

    expect(plist).toContain("<string>com.tend.app</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain("<string>/opt/tend/tend.ts</string>");
    expect(plist).toContain("<key>ATTENTION_AUTODRAIN</key>");
    expect(plist).toContain("<string>300000</string>");
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain("/tmp/tend home/logs/launchd.log");
    expect(plist).toContain("ATTENTION_API_PORT");
  });

  test("uses the standard user LaunchAgents location", () => {
    expect(launchdPlistPath("/Users/example")).toBe("/Users/example/Library/LaunchAgents/com.tend.app.plist");
  });
});
