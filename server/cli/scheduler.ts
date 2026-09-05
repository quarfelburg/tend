import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attentionHome } from "../paths";
import { print } from "./shared";

export const LAUNCHD_LABEL = "com.tend.app";
export const DEFAULT_AUTODRAIN_INTERVAL_MS = 5 * 60_000;

type LaunchdCommand = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type LaunchdConfig = {
  label?: string;
  plistPath?: string;
  home?: string;
  cwd?: string;
  cliCommand?: string[];
  apiPort?: string;
  autodrainIntervalMs?: number;
};

export function launchdPlistPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function launchdDomain(uid = process.getuid?.()): string {
  if (!uid) throw new Error("Could not determine the current macOS user id for launchd.");
  return `gui/${uid}`;
}

export function currentCliCommand(): string[] {
  const scriptPath = process.argv[1];
  if (scriptPath?.endsWith(".ts")) return [process.execPath, path.resolve(scriptPath)];
  return [process.execPath];
}

export function launchdPlist(config: LaunchdConfig = {}): string {
  const label = config.label ?? LAUNCHD_LABEL;
  const home = config.home ?? attentionHome();
  const cwd = config.cwd ?? process.cwd();
  const cliCommand = config.cliCommand ?? currentCliCommand();
  const intervalMs = config.autodrainIntervalMs ?? DEFAULT_AUTODRAIN_INTERVAL_MS;
  const intervalSeconds = Math.max(60, Math.round(intervalMs / 1000));
  const logPath = path.join(home, "logs", "launchd.log");
  const args = [...cliCommand, "start", "--foreground"];
  const environment: Record<string, string> = {
    ATTENTION_HOME: home,
    ATTENTION_AUTODRAIN: "1",
    ATTENTION_AUTODRAIN_INTERVAL_MS: String(intervalMs),
  };
  if (config.apiPort) environment.ATTENTION_API_PORT = config.apiPort;

  const xml = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const stringEntry = (value: string) => `<string>${xml(value)}</string>`;
  const array = (values: string[]) => `<array>\n${values.map(stringEntry).join("\n")}\n</array>`;
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    ${stringEntry(value)}`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringEntry(label)}
  <key>ProgramArguments</key>
  ${array(args)}
  <key>WorkingDirectory</key>
  ${stringEntry(cwd)}
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  ${stringEntry(logPath)}
  <key>StandardErrorPath</key>
  ${stringEntry(logPath)}
</dict>
</plist>
`;
}

async function runLaunchctl(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
    child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function assertMac(): void {
  if (process.platform !== "darwin") throw new Error("Tend's launchd scheduler is only available on macOS.");
}

export async function schedulerInstallCommand(options: { launchctl?: LaunchdCommand; config?: LaunchdConfig } = {}): Promise<void> {
  assertMac();
  const config = options.config ?? {};
  const plistPath = config.plistPath ?? launchdPlistPath();
  const home = config.home ?? attentionHome();
  const launchctl = options.launchctl ?? runLaunchctl;
  await mkdir(path.dirname(plistPath), { recursive: true });
  await mkdir(path.join(home, "logs"), { recursive: true });
  await writeFile(plistPath, launchdPlist({ ...config, plistPath }), { mode: 0o600 });
  await launchctl(["bootout", launchdDomain(), plistPath]);
  const loaded = await launchctl(["bootstrap", launchdDomain(), plistPath]);
  if (loaded.exitCode !== 0) {
    throw new Error(`Could not load the Tend launchd agent: ${loaded.stderr.trim() || loaded.stdout.trim() || `exit ${loaded.exitCode}`}`);
  }
  print(`Tend launchd scheduler installed (${plistPath}); autodrain checks every ${Math.round((config.autodrainIntervalMs ?? DEFAULT_AUTODRAIN_INTERVAL_MS) / 60_000)} minutes.`);
}

export async function schedulerUninstallCommand(options: { launchctl?: LaunchdCommand; plistPath?: string } = {}): Promise<void> {
  assertMac();
  const plistPath = options.plistPath ?? launchdPlistPath();
  await (options.launchctl ?? runLaunchctl)(["bootout", launchdDomain(), plistPath]);
  await rm(plistPath, { force: true });
  print(`Tend launchd scheduler removed (${plistPath}).`);
}

export async function schedulerStatusCommand(options: { launchctl?: LaunchdCommand; plistPath?: string } = {}): Promise<void> {
  assertMac();
  const plistPath = options.plistPath ?? launchdPlistPath();
  let installed = false;
  try {
    await readFile(plistPath, "utf8");
    installed = true;
  } catch {
    // The agent is not installed.
  }
  const loaded = await (options.launchctl ?? runLaunchctl)(["print", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  print({ installed, loaded: loaded.exitCode === 0, label: LAUNCHD_LABEL, plistPath });
}
