import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliPath, hashFile, type Release } from "../src/download.js";

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

interface Sandbox {
  home: string;
  cache: string;
}

function cleanEnv(box: Sandbox): NodeJS.ProcessEnv {
  return { HOME: box.home, XDG_CACHE_HOME: box.cache, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
}

function runCli(bin: string, args: string[], box: Sandbox): string {
  return execFileSync(bin, args, { env: cleanEnv(box), encoding: "utf8", timeout: STEP_TIMEOUT_MS }).trim();
}

interface Session {
  tools: string[];
  stderr: string;
}

function mcpSession(bin: string, box: Sandbox): Promise<Session> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["mcp"], { env: cleanEnv(box), stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`mcp session timed out: ${stderr}`));
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
      else resolve({ tools, stderr });
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

function checkTools(label: string, session: Session): void {
  const missing = REQUIRED_TOOLS.filter((name) => !session.tools.includes(name));
  if (missing.length > 0) throw new Error(`${label}: missing tools ${missing.join(", ")}`);
}

async function verifyInstall(label: string, projectDir: string, base: string, release: Release): Promise<void> {
  const bin = join(projectDir, "node_modules", ".bin", "tmgr-notify");
  const box: Sandbox = { home: join(base, `${label}-home`), cache: join(base, `${label}-cache`) };
  mkdirSync(box.home);
  mkdirSync(box.cache);
  log(`${label}: version ${runCli(bin, ["--version"], box)}`);

  const [a, b] = await Promise.all([mcpSession(bin, box), mcpSession(bin, box)]);
  checkTools(`${label} first run A`, a);
  checkTools(`${label} first run B`, b);
  log(`${label}: two concurrent cold runs ok (${a.tools.join(", ")})`);

  const pinned = release.platforms[`${process.platform}-${process.arch}`];
  const path = cliPath(box.cache, release, pinned);
  const files = readdirSync(dirname(path));
  if (files.length !== 1 || files[0] !== "tmgr") throw new Error(`${label}: unexpected cache contents ${files.join(", ")}`);
  const actual = await hashFile(path);
  if (actual !== pinned.binarySha256) throw new Error(`${label}: cached binary hash ${actual} != pinned ${pinned.binarySha256}`);
  log(`${label}: cache holds exactly one tmgr, sha256 matches pin`);

  const warm = await mcpSession(bin, box);
  checkTools(`${label} warm run`, warm);
  if (/downloading/.test(warm.stderr)) throw new Error(`${label}: warm run downloaded again: ${warm.stderr}`);
  log(`${label}: warm run ok, no download`);
}

function newProject(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true }));
  return dir;
}

async function run(base: string): Promise<void> {
  const release = JSON.parse(readFileSync(join(ROOT, "cli-release.json"), "utf8")) as Release;
  const key = `${process.platform}-${process.arch}`;
  if (!release.platforms[key]) {
    log(`no binary for ${key}, skipping`);
    return;
  }

  const tgzDir = join(base, "tgz");
  mkdirSync(tgzDir);
  const mainTgz = pack(ROOT, tgzDir);
  log(`packed ${mainTgz}`);

  const npmProject = newProject(base, "npm-project");
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", mainTgz], {
    cwd: npmProject,
    stdio: "inherit",
  });
  await verifyInstall("npm", npmProject, base, release);

  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
  } catch {
    log("pnpm not found, skipping pnpm check");
    return;
  }
  const pnpmProject = newProject(base, "pnpm-project");
  execFileSync("pnpm", ["add", "--ignore-scripts", "--store-dir", join(base, "pnpm-store"), mainTgz], {
    cwd: pnpmProject,
    stdio: "inherit",
  });
  await verifyInstall("pnpm", pnpmProject, base, release);
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
