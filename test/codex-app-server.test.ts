import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        if (message.method === "project/list") {
          console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "project-local", name: "Local", roots: [{ path: process.cwd() }] }] } }));
        }
        if (message.method === "thread/read") {
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "thread-chat" } } }));
        }
        if (message.method === "thread/metadata/update") {
          if (message.params.projectId !== "project-local") process.exit(7);
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
        if (message.method === "project/list") {
          console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "project-local", name: "Local", roots: [{ path: process.cwd() }] }] } }));
        }
        if (message.method === "thread/queue/add") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "thread/queue/add requires experimentalApi capability" } }));
        }
        if (message.method === "thread/read") {
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "thread-chat" } } }));
        }
        if (message.method === "thread/metadata/update") {
          if (message.params.projectId !== "project-local") process.exit(7);
          console.log(JSON.stringify({ id: message.id, result: {} }));
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
        if (message.method === "project/list") {
          console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "project-parent", name: "Parent", roots: [{ path: process.cwd() + "/.." }] }, { id: "project-local", name: "Local", roots: [{ path: process.cwd() }] }] } }));
        }
        if (message.method === "thread/queue/add") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "thread/queue/add requires experimentalApi capability" } }));
        }
        if (message.method === "thread/read") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "session thread-chat is archived. Run codex unarchive thread-chat to unarchive it first." } }));
        }
        if (message.method === "thread/start") {
          if (message.params.projectId !== "project-local") process.exit(7);
          if (message.params.cwd !== process.cwd()) process.exit(8);
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "thread-chat-replacement" } } }));
        }
        if (message.method === "thread/metadata/update") {
          if (message.params.threadId !== "thread-chat-replacement") process.exit(9);
          if (message.params.projectId !== "project-local") process.exit(10);
          console.log(JSON.stringify({ id: message.id, result: {} }));
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

  test("uses the enclosing Codex Desktop project root when the standalone app server has no project registry", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "tend-local-project-"));
    const tendRoot = path.join(projectRoot, "Tools", "tend");
    const desktopProjectsPath = path.join(projectRoot, "desktop-state.json");
    await mkdir(tendRoot, { recursive: true });
    await writeFile(desktopProjectsPath, JSON.stringify({
      "local-projects": {
        "desktop-project": {
          id: "desktop-project",
          name: "Company OS",
          rootPaths: [projectRoot],
        },
      },
    }));

    const fakeServer = `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "project/list") {
          console.log(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
        if (message.method === "thread/read") {
          console.log(JSON.stringify({ id: message.id, error: { code: -32600, message: "session thread-chat is archived. Run codex unarchive thread-chat to unarchive it first." } }));
        }
        if (message.method === "thread/start") {
          if (message.params.cwd !== ${JSON.stringify(projectRoot)}) process.exit(2);
          if ("projectId" in message.params) process.exit(3);
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "thread-local-replacement" } } }));
        }
        if (message.method === "thread/name/set") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/metadata/update") process.exit(4);
        if (message.method === "thread/queue/add") {
          if (message.params.threadId !== "thread-local-replacement") process.exit(5);
          console.log(JSON.stringify({ id: message.id, result: { queuedSubmission: { id: "queued-local" } } }));
        }
      });
    `;

    try {
      const result = await queueAppServerMessage({
        threadId: "thread-chat",
        threadName: "Tend — Content Creation",
        prompt: "Discuss this card locally.",
        cwd: tendRoot,
        desktopProjectsPath,
        argv: [process.execPath, "-e", fakeServer],
      });

      expect(result).toEqual({ queuedSubmissionId: "queued-local", mode: "queued", threadId: "thread-local-replacement" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("queues directly into a desktop-owned task without trying to acquire its writer", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "tend-active-writer-project-"));
    const tendRoot = path.join(projectRoot, "Tools", "tend");
    const desktopProjectsPath = path.join(projectRoot, "desktop-state.json");
    await mkdir(tendRoot, { recursive: true });
    await writeFile(desktopProjectsPath, JSON.stringify({
      "local-projects": {
        "desktop-project": {
          id: "desktop-project",
          name: "Company OS",
          rootPaths: [projectRoot],
        },
      },
    }));

    const fakeServer = `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "project/list") {
          console.log(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
        if (message.method === "thread/read") {
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "desktop-owned-thread", cwd: ${JSON.stringify(projectRoot)} } } }));
        }
        if (message.method === "thread/start") process.exit(2);
        if (message.method === "thread/resume") process.exit(3);
        if (message.method === "thread/name/set") {
          if (message.params.threadId !== "desktop-owned-thread") process.exit(4);
          if (message.params.name !== "What Should I Work on Next? (Tend > Content Creation)") process.exit(7);
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/metadata/update") process.exit(5);
        if (message.method === "thread/queue/add") {
          if (message.params.threadId !== "desktop-owned-thread") process.exit(6);
          console.log(JSON.stringify({ id: message.id, result: { queuedSubmission: { id: "queued-desktop" } } }));
        }
      });
    `;

    try {
      const result = await queueAppServerMessage({
        threadId: "desktop-owned-thread",
        threadName: "What Should I Work on Next? (Tend > Content Creation)",
        prompt: "Discuss this card locally.",
        cwd: tendRoot,
        desktopProjectsPath,
        argv: [process.execPath, "-e", fakeServer],
      });

      expect(result).toEqual({ queuedSubmissionId: "queued-desktop", mode: "queued", threadId: "desktop-owned-thread" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("replaces a nested ungrouped task at the enclosing Codex Desktop project root", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "tend-project-root-replacement-"));
    const tendRoot = path.join(projectRoot, "Tools", "tend");
    const desktopProjectsPath = path.join(projectRoot, "desktop-state.json");
    await mkdir(tendRoot, { recursive: true });
    await writeFile(desktopProjectsPath, JSON.stringify({
      "local-projects": {
        "desktop-project": {
          id: "desktop-project",
          name: "Company OS",
          rootPaths: [projectRoot],
        },
      },
    }));

    const fakeServer = `
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "project/list") {
          console.log(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
        if (message.method === "thread/read") {
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "nested-thread", cwd: ${JSON.stringify(tendRoot)} } } }));
        }
        if (message.method === "thread/start") {
          if (message.params.cwd !== ${JSON.stringify(projectRoot)}) process.exit(2);
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: "project-root-thread" } } }));
        }
        if (message.method === "thread/name/set") {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
        if (message.method === "thread/metadata/update") process.exit(3);
        if (message.method === "thread/queue/add") {
          if (message.params.threadId !== "project-root-thread") process.exit(4);
          console.log(JSON.stringify({ id: message.id, result: { queuedSubmission: { id: "queued-project-root" } } }));
        }
      });
    `;

    try {
      const result = await queueAppServerMessage({
        threadId: "nested-thread",
        threadName: "Tend — Content Creation",
        prompt: "Discuss this card locally.",
        cwd: tendRoot,
        desktopProjectsPath,
        argv: [process.execPath, "-e", fakeServer],
      });

      expect(result).toEqual({ queuedSubmissionId: "queued-project-root", mode: "queued", threadId: "project-root-thread" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
