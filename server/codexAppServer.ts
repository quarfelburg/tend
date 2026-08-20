import { existsSync } from "node:fs";
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
