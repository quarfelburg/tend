import { describe, expect, test } from "bun:test";
import { appServerArgv, queueAppServerMessage } from "../server/codexAppServer";

describe("appServerArgv", () => {
  test("resolves Codex to an executable path for background services", () => {
    const argv = appServerArgv(null);

    expect(argv[0]).toBe("/usr/bin/env");
    expect(argv[1]).toContain("codex");
    expect(argv.slice(2)).toEqual(["app-server"]);
  });
});

describe("queueAppServerMessage", () => {
  test("adds context to the thread queue without starting a turn", async () => {
    const fakeServer = `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/queue/add") {
          if (message.params.threadId !== "thread-chat") process.exit(2);
          if (message.params.input[0].text !== "Discuss this card first.") process.exit(3);
          console.log(JSON.stringify({ id: message.id, result: { queuedSubmission: { id: "queued-1", clientUserMessageId: message.params.clientUserMessageId, input: message.params.input } } }));
        }
        if (message.method === "turn/start" || message.method === "thread/queue/start") process.exit(4);
      });
    `;

    const result = await queueAppServerMessage({
      threadId: "thread-chat",
      prompt: "Discuss this card first.",
      cwd: process.cwd(),
      argv: [process.execPath, "-e", fakeServer],
    });

    expect(result).toEqual({ queuedSubmissionId: "queued-1" });
  });
});
