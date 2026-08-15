#!/usr/bin/env bun
import { formatCliError, helpText, parseCliArgs, readPackageMetadata } from "./cli";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const metadata = await readPackageMetadata();
const result = parseCliArgs(process.argv.slice(2));

if (result.kind === "help") {
  process.stdout.write(helpText(metadata));
} else if (result.kind === "version") {
  process.stdout.write(`${metadata.version}\n`);
} else if (result.kind === "error") {
  process.stderr.write(formatCliError(result.message));
  process.exitCode = 2;
} else if (result.kind === "sandboxSetup") {
  if (process.platform !== "linux") {
    process.stderr.write("PUM outer sandbox mode requires Linux. On Windows, run PUM inside WSL 2.\n");
    process.exitCode = 1;
  } else {
    const { probeOuterSandboxRuntime } = await import("./outer-sandbox-process");
    const probe = probeOuterSandboxRuntime();
    if (probe.available) {
      process.stdout.write(`Outer sandbox runtime is ready: ${probe.executable} (protocol 1)\n`);
    } else {
      process.stderr.write(
        "PUM outer sandbox runtime is not ready.\n"
        + `claudebox: ${probe.executable}\n`
        + `reason: ${probe.reason ?? "runtime probe failed"}\n\n`
        + "Install a protocol-1 claudebox build with runsc, pasta, iptables, ip6tables, ip, nsenter, and unshare.\n"
        + "Place claudebox on PATH or set PUM_CLAUDEBOX to its absolute path.\n",
      );
      process.exitCode = 1;
    }
  }
} else if (result.options.outerSandbox) {
  try {
    const { launchPumOuterSandbox } = await import("./outer-sandbox-launch");
    const childArgs = [
      ...(result.options.login ? ["login"] : []),
      ...(result.options.resume ? ["--resume"] : []),
    ];
    process.exitCode = await launchPumOuterSandbox({
      mode: result.options.outerSandbox.mode,
      cwd: process.cwd(),
      mounts: result.options.outerSandbox.mounts,
      childArgs,
    });
  } catch (error) {
    process.stderr.write(formatCliError(errorMessage(error)));
    process.exitCode = 1;
  }
} else {
  const { start } = await import("./main");
  await start(result.options);
}
