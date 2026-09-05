import { describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_MAX_CONFIG_BYTES, parseMcpConfig, readMcpProposal } from "../src/mcp-config";

const config = { version: 1 as const, servers: [{ name: "local", executable: "/usr/bin/node", args: ["server.js"] }] };
const text = JSON.stringify(config);
function temporary(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "pum-mcp-config-test-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

describe("inert MCP server proposals", () => {
  test("parses only explicit bounded version 1 argv without execution or expansion", () => {
    expect(parseMcpConfig(text)).toEqual(config);
    const literal = { version: 1 as const, servers: [{ name: "literal", executable: "/bin/tool", args: ["$(touch never)", "$SECRET", "", "space argument"] }] };
    expect(parseMcpConfig(JSON.stringify(literal))).toEqual(literal);
  });

  test("rejects unknown and credential/transport/environment fields", () => {
    for (const field of ["env", "url", "headers", "auth", "token", "transport", "autoStart", "approved"]) {
      expect(() => parseMcpConfig(JSON.stringify({ ...config, [field]: "secret-sentinel" }))).toThrow("Invalid MCP proposal");
      expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: [{ ...config.servers[0], [field]: "secret-sentinel" }] }))).toThrow("Invalid MCP proposal");
    }
    expect(() => parseMcpConfig('{"version":1,"servers":[],"__proto__":{}}')).toThrow();
  });

  test("bounds counts, bytes, identifiers, paths and control characters", () => {
    const invalid = [
      null, [], {}, { ...config, version: 2 }, { ...config, servers: [] },
      { ...config, servers: Array(5).fill(config.servers[0]) },
      { ...config, servers: [config.servers[0], config.servers[0]] },
      ...["Bad", "__proto__", "a".repeat(33), "a\u202e", "a\n"].map((name) => ({ ...config, servers: [{ ...config.servers[0], name }] })),
      ...["node", "/", "C:\\node.exe", "/bin/\u001bnode", "/" + "a".repeat(4096)].map((executable) => ({ ...config, servers: [{ ...config.servers[0], executable }] })),
      ...[null, "hello", Array(17).fill("x"), [1], ["a".repeat(1025)], ["😀".repeat(257)], ["a\n"], ["a\u009b"], ["a\u2066"]].map((args) => ({ ...config, servers: [{ ...config.servers[0], args }] })),
    ];
    for (const value of invalid) expect(() => parseMcpConfig(JSON.stringify(value))).toThrow("Invalid MCP proposal");
    expect(() => parseMcpConfig(" ".repeat(MCP_MAX_CONFIG_BYTES) + text)).toThrow();
    expect(() => parseMcpConfig("not json secret-sentinel")).toThrow("Invalid MCP proposal");
  });

  test("exact cwd only, stable raw-byte digest, whitespace changes require new digest", () => temporary((cwd) => {
    mkdirSync(join(cwd, ".pum"));
    writeFileSync(join(cwd, ".pum", "mcp.json"), text);
    const proposal = readMcpProposal(cwd);
    expect(proposal.config).toEqual(config);
    expect(proposal.digest).toBe(createHash("sha256").update(text).digest("hex"));
    writeFileSync(join(cwd, ".pum", "mcp.json"), text + "\n");
    expect(readMcpProposal(cwd).digest).not.toBe(proposal.digest);
    mkdirSync(join(cwd, "child"));
    expect(() => readMcpProposal(join(cwd, "child"))).toThrow("Cannot load .pum/mcp.json");
  }));

  test("rejects missing, malformed, oversized, invalid UTF-8 and nonregular files generically", () => temporary((cwd) => {
    expect(() => readMcpProposal(cwd)).toThrow("Cannot load .pum/mcp.json");
    mkdirSync(join(cwd, ".pum"));
    const path = join(cwd, ".pum", "mcp.json");
    for (const value of ["secret-sentinel", " ".repeat(MCP_MAX_CONFIG_BYTES + 1), Buffer.from([0xff, 0xfe])]) {
      writeFileSync(path, value);
      try { readMcpProposal(cwd); throw new Error("unexpected success"); }
      catch (error) {
        expect(String(error)).toContain("Cannot load .pum/mcp.json");
        expect(String(error)).not.toContain("secret-sentinel");
        expect(String(error)).not.toContain(cwd);
      }
    }
    rmSync(path);
    mkdirSync(path);
    expect(() => readMcpProposal(cwd)).toThrow();
  }));

  test("opens nonblocking so a replacement FIFO cannot hang synchronous proposal loading", () => temporary((cwd) => {
    mkdirSync(join(cwd, ".pum"));
    writeFileSync(join(cwd, ".pum", "mcp.json"), text);
    const original = fs.openSync;
    let flags = 0;
    const open = spyOn(fs, "openSync").mockImplementation(((path, options, mode) => {
      flags = options as number;
      return original(path, options, mode);
    }) as typeof fs.openSync);
    try {
      expect(readMcpProposal(cwd).config).toEqual(config);
      if (fs.constants.O_NONBLOCK) expect(flags & fs.constants.O_NONBLOCK).not.toBe(0);
    } finally { open.mockRestore(); }
  }));

  test.skipIf(process.platform === "win32")("rejects an ancestor swapped to a symlink during open even when the file inode is unchanged", () => temporary((cwd) => {
    const directory = join(cwd, ".pum");
    const moved = join(cwd, "moved");
    mkdirSync(directory);
    writeFileSync(join(directory, "mcp.json"), text);
    const original = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(((path, options, mode) => {
      fs.renameSync(directory, moved);
      symlinkSync(moved, directory);
      return original(path, options, mode);
    }) as typeof fs.openSync);
    try { expect(() => readMcpProposal(cwd)).toThrow("Cannot load .pum/mcp.json"); }
    finally { open.mockRestore(); }
  }));

  test.skipIf(process.platform === "win32")("rejects a regular-file name replacement between precheck and open", () => temporary((cwd) => {
    mkdirSync(join(cwd, ".pum"));
    const path = join(cwd, ".pum", "mcp.json");
    writeFileSync(path, text);
    const original = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(((target, options, mode) => {
      fs.renameSync(path, join(cwd, "previous"));
      writeFileSync(path, text);
      return original(target, options, mode);
    }) as typeof fs.openSync);
    try { expect(() => readMcpProposal(cwd)).toThrow("Cannot load .pum/mcp.json"); }
    finally { open.mockRestore(); }
  }));

  test("rejects hardlinked proposals", () => temporary((cwd) => {
    mkdirSync(join(cwd, ".pum"));
    writeFileSync(join(cwd, "source"), text);
    linkSync(join(cwd, "source"), join(cwd, ".pum", "mcp.json"));
    expect(() => readMcpProposal(cwd)).toThrow();
  }));

  test.skipIf(process.platform === "win32")("rejects linked file, directory and cwd components", () => temporary((cwd) => {
    const actual = join(cwd, "actual");
    mkdirSync(join(actual, ".pum"), { recursive: true });
    writeFileSync(join(actual, ".pum", "mcp.json"), text);
    symlinkSync(actual, join(cwd, "alias"));
    expect(() => readMcpProposal(join(cwd, "alias"))).toThrow();
    mkdirSync(join(cwd, "linked-dir"));
    symlinkSync(join(actual, ".pum"), join(cwd, "linked-dir", ".pum"));
    expect(() => readMcpProposal(join(cwd, "linked-dir"))).toThrow();
    mkdirSync(join(cwd, "linked-file", ".pum"), { recursive: true });
    symlinkSync(join(actual, ".pum", "mcp.json"), join(cwd, "linked-file", ".pum", "mcp.json"));
    expect(() => readMcpProposal(join(cwd, "linked-file"))).toThrow();
  }));
});
