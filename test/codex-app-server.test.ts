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
          if (message.params.capabilities.experimentalApi !== true) process.exit(5);
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

    expect(result).toEqual({ queuedSubmissionId: "queued-1", mode: "queued", threadId: "thread-chat" });
  });

  test("injects context without starting an agent turn when the quiet queue is unavailable", async () => {
    const fakeServer = `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/queue/add") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "thread/queue/add requires experimentalApi capability" } }));
        }
        if (message.method === "thread/resume") {
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "thread-chat" } } }));
        }
        if (message.method === "thread/inject_items") {
          if (message.params.threadId !== "thread-chat") process.exit(2);
          if (message.params.items[0].role !== "user") process.exit(3);
          if (message.params.items[0].content[0].text !== "Discuss this card first.") process.exit(4);
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "turn/start") process.exit(6);
      });
    `;

    const result = await queueAppServerMessage({
      threadId: "thread-chat",
      prompt: "Discuss this card first.",
      cwd: process.cwd(),
      argv: [process.execPath, "-e", fakeServer],
    });

    expect(result.mode).toBe("queued");
    expect(result.threadId).toBe("thread-chat");
    expect(result.queuedSubmissionId.length).toBeGreaterThan(0);
  });

  test("replaces an archived bound task before injecting fallback context", async () => {
    const fakeServer = `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/queue/add") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "thread/queue/add requires experimentalApi capability" } }));
        }
        if (message.method === "thread/resume") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "session thread-chat is archived. Run codex unarchive thread-chat to unarchive it first." } }));
        }
        if (message.method === "thread/start") {
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "thread-chat-replacement" } } }));
        }
        if (message.method === "thread/name/set") {
          if (message.params.threadId !== "thread-chat-replacement") process.exit(2);
          if (message.params.name !== "Tend — Content Creation") process.exit(3);
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/inject_items") {
          if (message.params.threadId !== "thread-chat-replacement") process.exit(4);
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/unarchive") process.exit(5);
        if (message.method === "turn/start") process.exit(6);
      });
    `;

    const result = await queueAppServerMessage({
      threadId: "thread-chat",
      threadName: "Tend — Content Creation",
      prompt: "Discuss this archived card.",
      cwd: process.cwd(),
      argv: [process.execPath, "-e", fakeServer],
    });

    expect(result.mode).toBe("queued");
    expect(result.threadId).toBe("thread-chat-replacement");
    expect(result.queuedSubmissionId.length).toBeGreaterThan(0);
  });
});
