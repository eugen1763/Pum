import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import type { ContainerConfig, PlatformSupport } from "@microsoft/mxc-sdk";
import type { SandboxPolicy } from "./types.js";
import {
	MxcSandboxBackend,
	buildWindowsMxcConfig,
	probeWindowsSandbox,
	quoteWindowsArgument,
	quoteWindowsCommandLine,
} from "./windows.js";

const supported: PlatformSupport = {
	isSupported: true,
	availableMethods: ["processcontainer"],
	isolationTier: "base-container",
	uiCapabilities: {
		canBlockClipboardRead: true,
		canBlockClipboardWrite: true,
		canBlockInputInjection: true,
		canBlockInputMethodChanges: true,
		canBlockExternalUiObjects: true,
		canBlockGlobalUiNamespace: true,
		canBlockDesktopSwitching: true,
		canBlockLogoffOrShutdown: true,
		canBlockSystemParameterChanges: true,
		canBlockDisplaySettingsChanges: true,
	},
};

const policy: SandboxPolicy = {
	version: 1,
	exactCommand: "tool --flag",
	cwd: "C:\\work",
	readOnlyPaths: ["C:\\tools", "c:\\tools\\"],
	readWritePaths: ["C:\\work"],
	deniedPaths: ["C:\\work\\.env"],
	privateTemp: "C:\\temp\\pum",
	environment: { PATH: "C:\\tools", TEMP: "C:\\host-temp", Token: "safe" },
	executable: "C:\\Program Files\\Tool\\tool.exe",
	args: ["", "plain", "two words", "quote\"here", "trailing\\"],
	network: "deny",
	rationale: "focused Windows backend test",
	accesses: [],
};

function configFactory(input: unknown): ContainerConfig {
	return {
		version: "0.7.0-alpha",
		containment: "process",
		process: { commandLine: "" },
		processContainer: {},
		network: {},
		...(typeof input === "object" ? {} : {}),
	};
}

describe("Windows argv quoting", () => {
	test("quotes empty, whitespace, quotes, and trailing backslashes", () => {
		expect(quoteWindowsArgument("")).toBe('""');
		expect(quoteWindowsArgument("plain")).toBe("plain");
		expect(quoteWindowsArgument("two words")).toBe('"two words"');
		expect(quoteWindowsArgument('quote"here')).toBe('"quote\\\"here"');
		expect(quoteWindowsArgument("two words\\")).toBe('"two words\\\\"');
	});

	test("keeps executable and argv boundaries", () => {
		expect(quoteWindowsCommandLine("C:\\Program Files\\x.exe", ["", "a b"])).toBe(
			'"C:\\Program Files\\x.exe" "" "a b"',
		);
	});
});

test("buildWindowsMxcConfig maps the complete restrictive policy", () => {
	let receivedPolicy: unknown;
	let containment: unknown;
	const config = buildWindowsMxcConfig(
		{
			createConfigFromPolicy: (input, selected) => {
				receivedPolicy = input;
				containment = selected;
				return configFactory(input);
			},
		},
		policy,
		2.5,
	);

	expect(containment).toBe("process");
	expect(receivedPolicy).toEqual({
		version: "0.7.0-alpha",
		filesystem: {
			readonlyPaths: ["C:\\tools", "C:\\Program Files\\Tool"],
			readwritePaths: ["C:\\work", "C:\\temp\\pum"],
			deniedPaths: ["C:\\work\\.env"],
			clearPolicyOnExit: true,
		},
		network: { allowOutbound: false, allowLocalNetwork: false },
		ui: { allowWindows: false, clipboard: "none", allowInputInjection: false },
		timeoutMs: 2500,
	});
	expect(config.process).toEqual({
		commandLine:
			'"C:\\Program Files\\Tool\\tool.exe" "" plain "two words" "quote\\\"here" trailing\\',
		cwd: "C:\\work",
		env: ["PATH=C:\\tools", "Token=safe", "TEMP=C:\\temp\\pum", "TMP=C:\\temp\\pum"],
		timeout: 2500,
	});
	expect(config.processContainer).toEqual({
		leastPrivilege: true,
		capabilities: [],
		ui: { isolation: "container", desktopSystemControl: false, systemSettings: "none", ime: false },
	});
	expect(config.network?.enforcementMode).toBe("capabilities");
});

test("buildWindowsMxcConfig never exposes a drive root for a bin shell", () => {
	let received: { filesystem: { readonlyPaths: string[] } } | undefined;
	buildWindowsMxcConfig(
		{
			createConfigFromPolicy: (input) => {
				received = input as typeof received;
				return configFactory(input);
			},
		},
		{ ...policy, executable: "C:\\bin\\bash.exe", readOnlyPaths: [] },
		undefined,
	);
	expect(received?.filesystem.readonlyPaths).toContain("C:\\bin");
	expect(received?.filesystem.readonlyPaths).not.toContain("C:\\");
	expect(received?.filesystem.readonlyPaths.some((path) => /^[A-Za-z]:\\?$/u.test(path))).toBe(false);
});

test("probe does not import MXC away from Windows", async () => {
	let loaded = false;
	const result = await probeWindowsSandbox(
		async () => {
			loaded = true;
			throw new Error("must not load");
		},
		"linux",
	);
	expect(loaded).toBe(false);
	expect(result).toEqual({ state: "unavailable", backend: "mxc", reason: "MXC ProcessContainer requires Windows" });
});

test("probe requires a successful native tier and UI capability probe", async () => {
	const result = await probeWindowsSandbox(
		async () => ({ getPlatformSupport: () => ({ isSupported: true, availableMethods: ["processcontainer"] }) }) as never,
		"win32",
	);
	expect(result.state).toBe("unavailable");
	expect(result.reason).toContain("isolation tier");
});

test("probe rejects the AppContainer DACL fallback to avoid host ACL changes", async () => {
	const result = await probeWindowsSandbox(
		async () => ({ getPlatformSupport: () => ({ ...supported, isolationTier: "appcontainer-dacl" }) }) as never,
		"win32",
	);
	expect(result.state).toBe("unavailable");
	expect(result.reason).toContain("does not use the AppContainer DACL fallback");
});

test("probe reports an enforced native ProcessContainer", async () => {
	const result = await probeWindowsSandbox(
		async () => ({ getPlatformSupport: () => supported }) as never,
		"win32",
	);
	expect(result).toEqual({ state: "enforced", backend: "mxc" });
});

test.skipIf(process.platform !== "win32")("default probe imports MXC with native Windows whoami first", async () => {
	const root = await mkdtemp(join(tmpdir(), "pum-mxc-whoami-"));
	const marker = join(root, "gnu-whoami-selected");
	const fakeWhoami = join(root, "whoami.cmd");
	await writeFile(
		fakeWhoami,
		`@echo off\r\necho GNU whoami selected 1^>^&2\r\necho selected>"${marker}"\r\nexit /b 1\r\n`,
		"utf8",
	);

	try {
		const windowsModule = pathToFileURL(join(import.meta.dir, "windows.ts")).href;
		const script = [
			'await import("node:child_process");',
			`const { createWindowsSandboxBackend } = await import(${JSON.stringify(windowsModule)});`,
			"await createWindowsSandboxBackend().probe();",
		].join("\n");
		const env = { ...process.env };
		for (const name of Object.keys(env)) {
			if (name.toLowerCase() === "path") delete env[name];
		}
		env.PATH = `${root}${delimiter}${process.env.PATH ?? ""}`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env,
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(0);
		expect(stderr).toBe("");
		await expect(access(marker)).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("probe reports a missing optional SDK without throwing", async () => {
	const result = await probeWindowsSandbox(async () => {
		throw new Error("module not found");
	}, "win32");
	expect(result).toEqual({
		state: "unavailable",
		backend: "mxc",
		reason: "Optional dependency @microsoft/mxc-sdk is unavailable: module not found",
	});
});

test("backend streams separate output, writes stdin, and reports the exit status", async () => {
	class FakeChild extends EventEmitter {
		stdout = new PassThrough();
		stderr = new PassThrough();
		stdin = new PassThrough();
		killCalls = 0;
		kill() {
			this.killCalls += 1;
			return true;
		}
	}
	const child = new FakeChild();
	const stdin: Buffer[] = [];
	child.stdin.on("data", (chunk) => stdin.push(chunk));
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const backend = new MxcSandboxBackend({
		platform: "win32",
		loader: async () =>
			({
				getPlatformSupport: () => supported,
				createConfigFromPolicy: configFactory,
				spawnSandboxFromConfig: () => child,
			}) as never,
	});
	const handle = backend.spawn(policy, {
		onStdout: (chunk) => stdout.push(chunk),
		onStderr: (chunk) => stderr.push(chunk),
		stdin: new Uint8Array([65, 66]),
	});
	await Bun.sleep(0);
	child.stdout.write("out");
	child.stderr.write("err");
	child.emit("close", 7, null);

	expect(await handle.completed).toEqual({ exitCode: 7, signal: null });
	expect(Buffer.concat(stdin).toString()).toBe("AB");
	expect(Buffer.concat(stdout).toString()).toBe("out");
	expect(Buffer.concat(stderr).toString()).toBe("err");
});

test("backend cancellation kills the MXC executor and rejects as aborted", async () => {
	class FakeChild extends EventEmitter {
		stdout = new PassThrough();
		stderr = new PassThrough();
		stdin = new PassThrough();
		killCalls = 0;
		kill() {
			this.killCalls += 1;
			queueMicrotask(() => this.emit("close", null, null));
			return true;
		}
	}
	const child = new FakeChild();
	const controller = new AbortController();
	const backend = new MxcSandboxBackend({
		platform: "win32",
		loader: async () =>
			({
				getPlatformSupport: () => supported,
				createConfigFromPolicy: configFactory,
				spawnSandboxFromConfig: () => child,
			}) as never,
	});
	const handle = backend.spawn(policy, {
		onStdout: () => {},
		onStderr: () => {},
		signal: controller.signal,
	});
	await Bun.sleep(0);
	controller.abort();
	await expect(handle.completed).rejects.toThrow("aborted");
	expect(child.killCalls).toBe(1);
});

test("does not misreport a plain non-zero exit as a timeout without a configured timeout", async () => {
	class FakeChild extends EventEmitter {
		stdout = new PassThrough();
		stderr = new PassThrough();
		stdin = new PassThrough();
		killCalls = 0;
		kill() {
			this.killCalls += 1;
			return true;
		}
	}
	const child = new FakeChild();
	const backend = new MxcSandboxBackend({
		platform: "win32",
		loader: async () =>
			({
				getPlatformSupport: () => supported,
				createConfigFromPolicy: configFactory,
				spawnSandboxFromConfig: () => child,
			}) as never,
	});
	const handle = backend.spawn(policy, {
		onStdout: () => {},
		onStderr: () => {},
	});
	await Bun.sleep(0);
	// A build tool prints this text on its own failure; no timeout was configured.
	child.stderr.write("error: the process timed out after 500ms waiting for a lock\n");
	child.emit("close", 1, null);
	expect(await handle.completed).toEqual({ exitCode: 1, signal: null });
	expect(child.killCalls).toBe(0);
});

test("backend maps the native MXC timeout envelope to pi timeout semantics", async () => {
	class FakeChild extends EventEmitter {
		stdout = new PassThrough();
		stderr = new PassThrough();
		stdin = new PassThrough();
		killCalls = 0;
		kill() {
			this.killCalls += 1;
			return true;
		}
	}
	const child = new FakeChild();
	const backend = new MxcSandboxBackend({
		platform: "win32",
		loader: async () =>
			({
				getPlatformSupport: () => supported,
				createConfigFromPolicy: configFactory,
				spawnSandboxFromConfig: () => child,
			}) as never,
	});
	const handle = backend.spawn(policy, {
		onStdout: () => {},
		onStderr: () => {},
		timeoutSeconds: 1,
	});
	await Bun.sleep(0);
	child.stderr.write('Process error: script timed out after 1000ms\n{"error":{"code":"backend_error"}}');
	child.emit("close", 255, null);
	await expect(handle.completed).rejects.toThrow("timeout:1");
	expect(child.killCalls).toBe(0);
});
