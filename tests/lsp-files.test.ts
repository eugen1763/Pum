import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_DIR } from "../src/config";
import { LSP_MAX_CONFIG_BYTES, LSP_MAX_DOCUMENT_BYTES, readLspDocument, readLspProposal } from "../src/lsp-files";
const config = { version: 1 as const, executable: "/usr/bin/server", args: ["--stdio"] };
const json = JSON.stringify(config);
function temporary(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "pum-lsp-files-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
function proposal(cwd: string): string {
  mkdirSync(join(cwd, ".pum"));
  const path = join(cwd, ".pum", "lsp.json");
  writeFileSync(path, json);
  return path;
}

describe("exact-cwd LSP proposal", () => {
  test("returns raw-byte digest and path chain identity, never discovers a parent proposal", () => temporary((cwd) => {
    const path = proposal(cwd);
    const first = readLspProposal(cwd);
    expect(first.config).toEqual(config);
    expect(first.digest).toBe(createHash("sha256").update(json).digest("hex"));
    expect(first.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(readLspProposal(cwd)).toEqual(first);
    writeFileSync(path, json + "\n");
    expect(readLspProposal(cwd).digest).not.toBe(first.digest);
    expect(readLspProposal(cwd).identity).toBe(first.identity);
    renameSync(path, path + ".old");
    writeFileSync(path, json);
    expect(readLspProposal(cwd).identity).not.toBe(first.identity);
    mkdirSync(join(cwd, "child"));
    expect(() => readLspProposal(join(cwd, "child"))).toThrow("Cannot load .pum/lsp.json");
  }));
  test("requires exactly the bounded flat schema", () => temporary((cwd) => {
    const path = proposal(cwd);
    for (const value of [null, [], {}, { ...config, version: 2 }, { ...config, executable: "server" },
      { ...config, executable: "/" }, { ...config, executable: "/" + "a".repeat(4096) },
      { ...config, executable: "/server\n" }, { ...config, args: "x" }, { ...config, args: [null] },
      { ...config, args: Array(17).fill("") }, { ...config, args: ["a".repeat(1025)] },
      { ...config, args: ["\u001b"] }, { ...config, args: ["\u202e"] },
      { ...config, env: {} }, { ...config, servers: [] }, { version: 1, executable: "/server" }]) {
      writeFileSync(path, JSON.stringify(value));
      expect(() => readLspProposal(cwd)).toThrow("Cannot load .pum/lsp.json");
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from("secret-sentinel"), Buffer.alloc(LSP_MAX_CONFIG_BYTES + 1, 32)]) {
      writeFileSync(path, bytes);
      expect(() => readLspProposal(cwd)).toThrow("Cannot load .pum/lsp.json");
    }
    writeFileSync(path, json + " ".repeat(LSP_MAX_CONFIG_BYTES - Buffer.byteLength(json)));
    expect(readLspProposal(cwd).config).toEqual(config);
  }));
  test("rejects file/ancestor symlinks, hardlinks, and nonregular files", () => temporary((cwd) => {
    const path = proposal(cwd);
    renameSync(path, path + ".original");
    symlinkSync(path + ".original", path);
    expect(() => readLspProposal(cwd)).toThrow();
    rmSync(path);
    linkSync(path + ".original", path);
    expect(() => readLspProposal(cwd)).toThrow();
    rmSync(path);
    mkdirSync(path);
    expect(() => readLspProposal(cwd)).toThrow();
    rmSync(path, { recursive: true });
    renameSync(join(cwd, ".pum"), join(cwd, "actual"));
    symlinkSync(join(cwd, "actual"), join(cwd, ".pum"));
    expect(() => readLspProposal(cwd)).toThrow();
    symlinkSync(cwd, join(cwd, "alias"));
    expect(() => readLspProposal(join(cwd, "alias"))).toThrow();
  }));
  test("identity tracks replaced directories even when config bytes and inode survive", () => temporary((cwd) => {
    const path = proposal(cwd);
    const first = readLspProposal(cwd);
    renameSync(join(cwd, ".pum"), join(cwd, "old"));
    mkdirSync(join(cwd, ".pum"));
    renameSync(join(cwd, "old", "lsp.json"), path);
    const second = readLspProposal(cwd);
    expect(second.digest).toBe(first.digest);
    expect(second.identity).not.toBe(first.identity);
  }));
  test("rechecks ancestors after reading even when the file inode survives", () => temporary((cwd) => {
    const path = proposal(cwd);
    const original = fs.readSync;
    let replaced = false;
    const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = original(...args);
      if (!replaced) {
        replaced = true;
        renameSync(join(cwd, ".pum"), join(cwd, "old"));
        mkdirSync(join(cwd, ".pum"));
        renameSync(join(cwd, "old", "lsp.json"), path);
      }
      return count;
    }) as typeof fs.readSync);
    try { expect(() => readLspProposal(cwd)).toThrow(); } finally { spy.mockRestore(); }
  }));
  test("detects replacement of an ancestor during descriptor open", () => temporary((cwd) => {
    proposal(cwd);
    const original = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
      renameSync(join(cwd, ".pum"), join(cwd, "old"));
      mkdirSync(join(cwd, ".pum"));
      writeFileSync(join(cwd, ".pum", "lsp.json"), json);
      return original(path, flags, mode);
    }) as typeof fs.openSync);
    try { expect(() => readLspProposal(cwd)).toThrow(); } finally { spy.mockRestore(); }
  }));
});

describe("bounded stale-safe Python documents", () => {
  test("preserves text, escapes URIs, and fingerprints edits plus byte restoration", () => temporary((cwd) => {
    const name = "hello # world.py";
    const path = join(cwd, name);
    const text = "\ufeff# café\r\n\tprint('ok')\n";
    writeFileSync(path, text);
    const first = readLspDocument(cwd, name);
    expect(first).toMatchObject({ path, relativePath: name, uri: pathToFileURL(path).href, text });
    expect(readLspDocument(cwd, name)).toEqual(first);
    const stat = fs.statSync(path);
    writeFileSync(path, "# changed\n");
    expect(readLspDocument(cwd, name).fingerprint).not.toBe(first.fingerprint);
    writeFileSync(path, text);
    utimesSync(path, stat.atime, stat.mtime);
    expect(readLspDocument(cwd, name).fingerprint).not.toBe(first.fingerprint);
    const restored = readLspDocument(cwd, name);
    renameSync(path, path + ".old");
    writeFileSync(path, text);
    expect(readLspDocument(cwd, name).fingerprint).not.toBe(restored.fingerprint);
  }));
  test("directory replacement invalidates identity even with the original file inode", () => temporary((cwd) => {
    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "nested", "a.py"), "x = 1\n");
    const first = readLspDocument(cwd, "nested/a.py");
    renameSync(join(cwd, "nested"), join(cwd, "old"));
    mkdirSync(join(cwd, "nested"));
    renameSync(join(cwd, "old", "a.py"), join(cwd, "nested", "a.py"));
    expect(readLspDocument(cwd, "nested/a.py").fingerprint).not.toBe(first.fingerprint);
  }));
  test("rejects traversal, absolutes, control paths, wrong extensions and sensitive names", () => temporary((cwd) => {
    writeFileSync(join(cwd, "a.py"), "pass\n");
    for (const path of ["../a.py", "nested/../a.py", "./a.py", "/a.py", "C:\\a.py", "C:a.py", "a\\b.py",
      "a//b.py", "a.py\n", "a.txt", "a.PY", "a".repeat(4097) + ".py", ".env.py", "secrets/a.py", ".ssh/a.py"]) {
      expect(() => readLspDocument(cwd, path)).toThrow("Cannot read LSP document");
    }
    expect(() => readLspDocument(AGENT_DIR, "a.py")).toThrow("Cannot read LSP document");
    mkdirSync(join(cwd, ".ssh"));
    writeFileSync(join(cwd, ".ssh", "a.py"), "pass\n");
    expect(() => readLspDocument(cwd, ".ssh/a.py")).toThrow();
  }));
  test("rejects links in any component and multiply linked or nonregular documents", () => temporary((cwd) => {
    writeFileSync(join(cwd, "a.py"), "pass\n");
    symlinkSync(join(cwd, "a.py"), join(cwd, "link.py"));
    expect(() => readLspDocument(cwd, "link.py")).toThrow();
    symlinkSync(cwd, join(cwd, "alias"));
    expect(() => readLspDocument(cwd, "alias/a.py")).toThrow();
    expect(() => readLspDocument(join(cwd, "alias"), "a.py")).toThrow();
    linkSync(join(cwd, "a.py"), join(cwd, "hard.py"));
    expect(() => readLspDocument(cwd, "a.py")).toThrow();
    mkdirSync(join(cwd, "directory.py"));
    expect(() => readLspDocument(cwd, "directory.py")).toThrow();
  }));
  test("enforces exact byte bounds, fatal UTF-8 and text controls", () => temporary((cwd) => {
    const path = join(cwd, "a.py");
    writeFileSync(path, Buffer.alloc(LSP_MAX_DOCUMENT_BYTES, 32));
    expect(readLspDocument(cwd, "a.py").text.length).toBe(LSP_MAX_DOCUMENT_BYTES);
    for (const bytes of [Buffer.alloc(LSP_MAX_DOCUMENT_BYTES + 1, 32), Buffer.from([0xc3, 0x28]),
      Buffer.from([0]), Buffer.from("x\u001b"), Buffer.from("x\u0085"), Buffer.from("x\u202e")]) {
      writeFileSync(path, bytes);
      expect(() => readLspDocument(cwd, "a.py")).toThrow();
    }
  }));
  test("rejects mutation during bounded read and uses nonblocking nofollow descriptor flags", () => temporary((cwd) => {
    const path = join(cwd, "a.py");
    writeFileSync(path, "pass\n");
    const original = fs.readSync;
    const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      writeFileSync(path, "different\n");
      return original(...args);
    }) as typeof fs.readSync);
    try { expect(() => readLspDocument(cwd, "a.py")).toThrow(); } finally { spy.mockRestore(); }
    const open = spyOn(fs, "openSync");
    try {
      readLspDocument(cwd, "a.py");
      const flags = open.mock.calls[0]![1] as number;
      expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
      expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    } finally { open.mockRestore(); }
  }));
});
