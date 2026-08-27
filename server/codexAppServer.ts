import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

declare const Bun: {
  which(binary: string): string | null;
  spawn(command: string[], options?: Record<string, unknown>): {
    exited: Promise<number>;
    kill(signal?: number): void;
    stdin: { write(chunk: string): unknown; flush?: () => unknown; end(): unknown };
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
  };
};

export const DEFAULT_CONTROL_SOCKET = path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");

export interface AppServerDrainOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  writableRoots?: string[];
  controlSocket?: string | null;
  timeoutMs?: number;
  log?: (line: string) => void | Promise<void>;
  argv?: string[];
}

export interface AppServerQueuedMessageOptions {
  threadId: string;
  threadName?: string;
  prompt: string;
  cwd: string;
  controlSocket?: string | null;
  timeoutMs?: number;
  log?: (line: string) => void | Promise<void>;
  argv?: string[];
  desktopProjectsPath?: string | null;
}

export type AppServerTaskChatHandoff = {
  queuedSubmissionId: string;
  mode: "queued" | "started";
  threadId: string;
};

type AppServerProject = {
  id: string;
  name: string;
  roots: Array<{ path: string }>;
};

type AppServerProjectMatch = {
  id: string;
  rootPath: string;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export function appServerArgv(controlSocket: string | null | undefined): string[] {
  const socket = controlSocket === null ? null : controlSocket ?? DEFAULT_CONTROL_SOCKET;
  const codex = Bun.which("codex") ?? "codex";
  const command = ["/usr/bin/env", codex, "app-server"];
  if (socket && existsSync(socket)) return [...command, "proxy", "--sock", socket];
  return command;
}

function queueAddUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("thread/queue/add") && (
    normalized.includes("experimentalapi")
    || normalized.includes("experimental api")
    || normalized.includes("method not found")
    || normalized.includes("-32600")
  );
}

function archivedThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("is archived") && normalized.includes("unarchive");
}

function threadHasActiveWriter(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("already has an active writer");
}

function projectForCwd(projects: AppServerProject[], cwd: string): AppServerProjectMatch | null {
  const resolvedCwd = path.resolve(cwd);
  const matches = projects.flatMap((project) => project.roots.map((root) => ({
    id: project.id,
    rootPath: path.resolve(root.path),
  }))).filter((candidate) => {
    const relative = path.relative(candidate.rootPath, resolvedCwd);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  return matches.sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null;
}

async function readDesktopProjectMatch(cwd: string, statePath?: string | null): Promise<AppServerProjectMatch | null> {
  if (statePath === null) return null;
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const contents = await readFile(statePath ?? path.join(codexHome, ".codex-global-state.json"), "utf8");
  const state = JSON.parse(contents) as {
    "local-projects"?: Record<string, { id?: string; name?: string; rootPaths?: string[] }>;
  };
  const projects = Object.values(state["local-projects"] ?? {}).flatMap((project) => {
    if (!project.id || !Array.isArray(project.rootPaths)) return [];
    return [{
      id: project.id,
      name: project.name ?? project.id,
      roots: project.rootPaths.map((rootPath) => ({ path: rootPath })),
    }];
  });
  return projectForCwd(projects, cwd);
}

export async function queueAppServerMessage(options: AppServerQueuedMessageOptions): Promise<AppServerTaskChatHandoff> {
  const log = options.log ?? (() => {});
  const argv = options.argv ?? appServerArgv(options.controlSocket);
  const timeoutMs = options.timeoutMs ?? 10_000;
  await log(`[app-server] queueing task-chat context via: ${argv.join(" ")}`);

  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush?.();
  };
  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ method, id, ...(params === undefined ? {} : { params }) });
    return response;
  };

  const readStdout = (async () => {
    if (!child.stdout) throw new Error("Codex app server did not expose a response stream.");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          await log(`[app-server:raw] ${line.slice(0, 400)}`);
          continue;
        }
        if (message.id === undefined || message.method !== undefined) continue;
        const entry = pending.get(message.id as number);
        if (!entry) continue;
        pending.delete(message.id as number);
        if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error).slice(0, 1_000)));
        else entry.resolve(message.result);
      }
    }
    for (const entry of pending.values()) entry.reject(new Error("Codex app server closed before returning a response."));
    pending.clear();
  })();
  const readStderr = (async () => {
    if (!child.stderr) return;
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
      const line = decoder.decode(chunk).trimEnd();
      if (line) await log(`[app-server:err] ${line}`);
    }
  })();
  const withTimeout = <T>(promise: Promise<T>): Promise<T> => Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Timed out while adding context to the Codex task.")), timeoutMs)),
  ]);

  try {
    await withTimeout(request("initialize", {
      clientInfo: { name: "tend_task_chat", title: "Tend task chat", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }));
    send({ method: "initialized" });
    let projectMatch: AppServerProjectMatch | null = null;
    let projectCanBeAssigned = false;
    try {
      const projects = await withTimeout(request("project/list", { limit: 100 })) as { data?: AppServerProject[] };
      projectMatch = projectForCwd(projects.data ?? [], options.cwd);
      projectCanBeAssigned = projectMatch !== null;
    } catch (error) {
      await log(`[app-server] app-server project lookup unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!projectMatch) {
      try {
        projectMatch = await readDesktopProjectMatch(options.cwd, options.desktopProjectsPath);
        if (projectMatch) await log(`[app-server] matched the Codex Desktop local project ${projectMatch.id} at ${projectMatch.rootPath}`);
      } catch (error) {
        await log(`[app-server] Codex Desktop project lookup unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (projectMatch && projectCanBeAssigned) await log(`[app-server] assigning task chat to local project ${projectMatch.id} at ${projectMatch.rootPath}`);
    if (!projectMatch) await log(`[app-server] no saved local project contains ${options.cwd}; keeping the task ungrouped`);
    const threadCwd = projectMatch?.rootPath ?? options.cwd;
    const addToQueue = (threadId: string) => withTimeout(request("thread/queue/add", {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: options.prompt }],
    })) as Promise<{ queuedSubmission?: { id?: string } }>;
    const injectContext = (threadId: string) => withTimeout(request("thread/inject_items", {
      threadId,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.prompt }],
      }],
    }));
    const readThread = (threadId: string) => withTimeout(request("thread/read", {
      threadId,
      includeTurns: false,
    })) as Promise<{ thread?: { cwd?: string } }>;
    const startReplacementThread = async (reason: "archived" | "active-writer" | "wrong-project-root"): Promise<string> => {
      const detail = reason === "archived"
        ? "is archived"
        : reason === "active-writer"
          ? "is owned by a different Codex process"
          : "is outside the enclosing saved Codex project";
      await log(`[app-server] bound task ${options.threadId} ${detail}; creating a fresh local conversation that Tend can continue`);
      const result = await withTimeout(request("thread/start", {
        cwd: threadCwd,
        ...(projectMatch && projectCanBeAssigned ? { projectId: projectMatch.id } : {}),
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      })) as { thread?: { id?: string } };
      const threadId = result.thread?.id;
      if (!threadId) throw new Error("Codex did not return the replacement task ID.");
      return threadId;
    };
    const nameThread = async (threadId: string): Promise<void> => {
      if (!options.threadName) return;
      await withTimeout(request("thread/name/set", { threadId, name: options.threadName }));
    };
    const prepareSavedThread = async (): Promise<string> => {
      let threadId = options.threadId;
      try {
        const result = await readThread(threadId);
        const savedCwd = result.thread?.cwd;
        if (projectMatch && savedCwd && path.resolve(savedCwd) !== path.resolve(threadCwd)) {
          threadId = await startReplacementThread("wrong-project-root");
        }
      } catch (error) {
        if (archivedThread(error)) threadId = await startReplacementThread("archived");
        else if (threadHasActiveWriter(error)) threadId = await startReplacementThread("active-writer");
        else await log(`[app-server] saved task metadata lookup unavailable; attempting a direct quiet handoff: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (projectMatch && projectCanBeAssigned) {
        await withTimeout(request("thread/metadata/update", { threadId, projectId: projectMatch.id }));
      }
      return threadId;
    };
    const injectIntoSavedThread = async (threadId: string): Promise<string> => {
      await injectContext(threadId);
      return threadId;
    };
    let threadId = await prepareSavedThread();
    await nameThread(threadId);
    try {
      const result = await addToQueue(threadId);
      const queuedSubmissionId = result.queuedSubmission?.id;
      if (!queuedSubmissionId) throw new Error("Codex did not confirm the queued conversation context.");
      return { queuedSubmissionId, mode: "queued", threadId };
    } catch (error) {
      if (archivedThread(error) || threadHasActiveWriter(error)) {
        threadId = await startReplacementThread(archivedThread(error) ? "archived" : "active-writer");
        await nameThread(threadId);
        if (projectMatch && projectCanBeAssigned) {
          await withTimeout(request("thread/metadata/update", { threadId, projectId: projectMatch.id }));
        }
        const result = await addToQueue(threadId);
        const queuedSubmissionId = result.queuedSubmission?.id;
        if (!queuedSubmissionId) throw new Error("Codex did not confirm the queued conversation context.");
        return { queuedSubmissionId, mode: "queued", threadId };
      }
      if (!queueAddUnavailable(error)) throw error;
      await log("[app-server] quiet task-chat queue is unavailable; injecting the context without starting an agent turn");
      await injectIntoSavedThread(threadId);
      return { queuedSubmissionId: randomUUID(), mode: "queued", threadId };
    }
  } finally {
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    const exitedGracefully = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!exitedGracefully) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
    await Promise.allSettled([readStdout, readStderr]);
  }
}

export async function runAppServerDrain(options: AppServerDrainOptions): Promise<number> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? Number(process.env.ATTENTION_DRAIN_TIMEOUT_MS ?? 15 * 60_000);
  const argv = options.argv ?? appServerArgv(options.controlSocket);
  await log(`[app-server] launching: ${argv.join(" ")}`);

  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let settled = false;
  let exitCode = 1;

  const finish = (code: number, reason: string) => {
    if (settled) return;
    settled = true;
    exitCode = code;
    void log(`[app-server] ${reason}`);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush?.();
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ method, id, ...(params === undefined ? {} : { params }) });
    return promise;
  };

  const answerServerRequest = (id: unknown, method: string) => {
    void log(`[app-server] declining server request ${method}`);
    const result = method === "execCommandApproval" || method === "applyPatchApproval"
      ? { decision: "denied" }
      : { decision: "decline" };
    send({ id, result } as Record<string, unknown>);
  };

  const pipeStderr = (async () => {
    if (!child.stderr) return;
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
      await log(`[app-server:err] ${decoder.decode(chunk).trimEnd()}`);
    }
  })();

  const turnDone = new Promise<void>((resolveTurn) => {
    void (async () => {
      if (!child.stdout) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            await log(`[app-server:raw] ${line.slice(0, 400)}`);
            continue;
          }
          if (message.id !== undefined && message.method === undefined) {
            const entry = pending.get(message.id as number);
            if (!entry) continue;
            pending.delete(message.id as number);
            if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error).slice(0, 500)));
            else entry.resolve(message.result);
            continue;
          }
          if (message.id !== undefined && typeof message.method === "string") {
            answerServerRequest(message.id, message.method);
            continue;
          }
          if (message.method === "turn/completed") {
            const params = message.params as { threadId?: string; turn?: { status?: string } } | undefined;
            if (params?.threadId === options.threadId) {
              const status = params.turn?.status ?? "unknown";
              finish(status === "completed" ? 0 : 1, `turn finished with status ${status}`);
              resolveTurn();
            }
          }
        }
      }
      resolveTurn();
    })();
  });

  const timeout = setTimeout(() => {
    finish(1, `drain timed out after ${Math.round(timeoutMs / 1000)}s`);
  }, timeoutMs);

  try {
    await request("initialize", { clientInfo: { name: "tend_dispatcher", title: "Tend auto-drain", version: "0.1.0" } });
    send({ method: "initialized" });
    await request("thread/resume", {
      threadId: options.threadId,
      cwd: options.cwd,
      approvalPolicy: "never",
      persistExtendedHistory: false,
    });
    await request("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt }],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: options.writableRoots ?? [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    await turnDone;
  } catch (error) {
    finish(1, `protocol failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await pipeStderr.catch(() => {});
    if (!settled) finish(1, "app-server exited before the turn completed");
  }
  return exitCode;
}
