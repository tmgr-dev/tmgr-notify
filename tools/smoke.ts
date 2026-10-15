import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlatform, loadInputs } from "./build-platform-packages.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_TOOLS = ["notify_user", "alarm", "alarm_status", "tmgr_cli"];
const STEP_TIMEOUT_MS = 30_000;

function log(message: string): void {
  console.log(`smoke: ${message}`);
}

function pack(cwd: string, destination: string): string {
  const out = execFileSync("npm", ["pack", "--pack-destination", destination, "--silent"], {
    cwd,
    encoding: "utf8",
  });
  const name = out.trim().split("\n").pop() as string;
  return join(destination, name);
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
}

function runCli(bin: string, args: string[], home: string): string {
  return execFileSync(bin, args, {
    env: cleanEnv(home),
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
  }).trim();
}

function mcpSession(bin: string, home: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["mcp"], { env: cleanEnv(home), stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mcp session timed out"));
    }, STEP_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    let toolsSent = false;
    let tools: string[] | undefined;

    const send = (message: object): void => {
      child.stdin.write(JSON.stringify(message) + "\n");
    };

    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1 && !toolsSent) {
          toolsSent = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          tools = message.result.tools.map((tool: { name: string }) => tool.name);
          child.stdin.end();
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!tools) reject(new Error(`mcp exited (${code}) without tools/list: ${stderr}`));
      else if (code !== 0) reject(new Error(`mcp exited with ${code}: ${stderr}`));
      else resolve(tools);
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    });
  });
}

async function verifyInstall(label: string, projectDir: string, home: string): Promise<void> {
  const bin = join(projectDir, "node_modules", ".bin", "tmgr-notify");
  log(`${label}: version ${runCli(bin, ["--version"], home)}`);
  const tools = await mcpSession(bin, home);
  const missing = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
  if (missing.length > 0) throw new Error(`${label}: missing tools ${missing.join(", ")}`);
  log(`${label}: mcp ok (${tools.join(", ")})`);
}

function newProject(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true }));
  return dir;
}

async function run(base: string): Promise<void> {
  const { release, packageVersion } = await loadInputs();
  const key = `${process.platform}-${process.arch}`;
  if (!release.platforms[key]) {
    log(`no binary for ${key}, skipping`);
    return;
  }

  const home = join(base, "home");
  mkdirSync(home);
  const tgzDir = join(base, "tgz");
  mkdirSync(tgzDir);

  const platformDir = await buildPlatform({
    key,
    release,
    packageVersion,
    outDir: join(base, "dist-npm"),
  });
  const platformTgz = pack(platformDir, tgzDir);
  const mainTgz = pack(ROOT, tgzDir);
  log(`packed ${platformTgz} and ${mainTgz}`);

  const npmProject = newProject(base, "npm-project");
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", mainTgz, platformTgz],
    { cwd: npmProject, stdio: "inherit" },
  );
  await verifyInstall("npm", npmProject, home);

  let pnpmAvailable = true;
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
  } catch {
    pnpmAvailable = false;
  }
  if (!pnpmAvailable) {
    log("pnpm not found, skipping pnpm check");
    return;
  }
  const pnpmProject = newProject(base, "pnpm-project");
  execFileSync(
    "pnpm",
    ["add", "--ignore-scripts", "--store-dir", join(base, "pnpm-store"), mainTgz, platformTgz],
    { cwd: pnpmProject, stdio: "inherit" },
  );
  await verifyInstall("pnpm", pnpmProject, home);
}

async function main(): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tmgr-notify-smoke-")));
  try {
    await run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
