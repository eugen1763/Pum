import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspProtocolClient } from "../src/lsp-protocol";
import { createMcpProcessAdapter, type McpProcessHandle } from "../src/mcp-process";
import { probeBubblewrap } from "../src/sandbox/linux";

// Real probe only: no mocked OS capability, downloads, installation or fallback.
const capability = process.platform === "linux" ? await probeBubblewrap() : undefined;
const enforced = capability?.state === "enforced";
const python = "/usr/bin/python3";
const hasPython = existsSync(python);
const serverFixture = fileURLToPath(new URL("./fixtures/lsp-native-server.py", import.meta.url));
const documentText = "answer = 42\n";

async function fixture() {
  // Canonicalize temp ancestors (notably /var on macOS); never use real PUM state.
  const root = await mkdtemp(join(await realpath(tmpdir()), "pum-lsp-native-"));
  try {
    const cwd = join(root, "project");
    const configDir = join(cwd, "fixture-config");
    await mkdir(configDir, { recursive: true });
    const sentinel = join(configDir, "sentinel.txt");
    const document = join(cwd, "example.py");
    const server = join(cwd, "server.py");
    await writeFile(sentinel, "harmless fixture sentinel\n");
    await writeFile(document, documentText);
    await copyFile(serverFixture, server);
    return { root, cwd, configDir, sentinel, document, server };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function unchanged(files: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(files.document, "utf8")).toBe(documentText);
  expect(await readFile(files.sentinel, "utf8")).toBe("harmless fixture sentinel\n");
  expect(await readFile(files.server, "utf8")).toBe(await readFile(serverFixture, "utf8"));
  expect((await readdir(files.cwd)).sort()).toEqual(["example.py", "fixture-config", "server.py"]);
  expect(await readdir(files.configDir)).toEqual(["sentinel.txt"]);
}

async function closeListener(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const nativeSkipReason = !enforced ? " (skip: native Bubblewrap probe not enforced)"
  : !hasPython ? " (skip: existing /usr/bin/python3 unavailable)" : "";
test.skipIf(!enforced || !hasPython)(`real confined LSP document pull denies writes, configuration, environment and host network${nativeSkipReason}`, async () => {
  const files = await fixture();
  const abort = new AbortController();
  const sockets = new Set<Socket>();
  let connections = 0;
  const listener = createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.end();
  });
  let client: LspProtocolClient | undefined;
  let handle: McpProcessHandle | undefined;
  const envName = "PUM_LSP_NATIVE_TEST_SECRET";
  const priorEnv = process.env[envName];
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => { listener.off("error", reject); resolve(); });
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    const networkNamespace = await readlink("/proc/self/ns/net");
    // A known harmless inherited variable makes filtering substantive, not vacuous.
    process.env[envName] = "harmless-fixture-only";
    const adapter = createMcpProcessAdapter({ configDir: files.configDir });
    client = await LspProtocolClient.connect(async request => {
      handle = await adapter.spawn(request);
      return handle;
    }, { cwd: files.cwd, executable: python, args: ["-B", files.server, files.sentinel, String(address.port), networkNamespace] },
    { signal: abort.signal });
    const diagnostics = await client.diagnostics(pathToFileURL(files.document).href, documentText, 1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ line: 0, character: 0, severity: 3 });
    expect(JSON.parse(diagnostics[0]!.message)).toEqual({
      projectWriteDenied: true, configReadDenied: true, networkDenied: true,
      networkNamespaceIsolated: true, environmentFiltered: true, credentialsAbsent: true,
      fullDocumentSynchronized: true,
    });
    expect(connections).toBe(0);
    await client.close();
    await handle!.completed.catch(() => {});
    await unchanged(files);
  } finally {
    if (priorEnv === undefined) delete process.env[envName]; else process.env[envName] = priorEnv;
    abort.abort();
    handle?.kill();
    await client?.close();
    await handle?.completed.catch(() => {});
    try { await closeListener(listener, sockets); }
    finally { await rm(files.root, { recursive: true, force: true }); }
  }
}, 25_000);

// On this host this is a real failure-path integration, not a fake native pass.
// Hosts with enforcement instead execute the positive integration above.
test.skipIf(enforced)("missing or failed real native probe refuses LSP connection without spawning a fallback", async () => {
  const files = await fixture();
  let handle: McpProcessHandle | undefined;
  let client: LspProtocolClient | undefined;
  let outputBytes = 0;
  const adapter = createMcpProcessAdapter({ configDir: files.configDir });
  try {
    await expect(adapter.spawn({ cwd: files.cwd, executable: python, args: ["-B", files.server],
      onStdout(data) { outputBytes += data.byteLength; }, onStderr(data) { outputBytes += data.byteLength; },
    }).then(value => { handle = value; return value; })).rejects.toThrow("native policy");
    expect(handle).toBeUndefined();
    await expect(LspProtocolClient.connect(async request => {
      handle = await adapter.spawn(request);
      return handle;
    }, { cwd: files.cwd, executable: python, args: ["-B", files.server] })
      .then(value => { client = value; return value; })).rejects.toThrow("LSP connection failed");
    expect(handle).toBeUndefined();
    expect(outputBytes).toBe(0);
    await unchanged(files);
  } finally {
    handle?.kill();
    await client?.close();
    await handle?.completed.catch(() => {});
    await rm(files.root, { recursive: true, force: true });
  }
}, 25_000);

test("revoked native launch is refused on every host, without a process or fallback", async () => {
  const files = await fixture();
  const abort = new AbortController();
  abort.abort();
  let handle: McpProcessHandle | undefined;
  try {
    await expect(createMcpProcessAdapter({ configDir: files.configDir }).spawn({
      cwd: files.cwd, executable: python, args: ["-B", files.server], signal: abort.signal,
      onStdout() { throw new Error("Unexpected process output"); },
      onStderr() { throw new Error("Unexpected process output"); },
    }).then(value => { handle = value; return value; })).rejects.toThrow("native policy");
    expect(handle).toBeUndefined();
    await unchanged(files);
  } finally {
    handle?.kill();
    await handle?.completed.catch(() => {});
    await rm(files.root, { recursive: true, force: true });
  }
});
