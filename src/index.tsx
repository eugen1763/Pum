#!/usr/bin/env bun
import { formatCliError, helpText, parseCliArgs, readPackageMetadata } from "./cli";

const metadata = await readPackageMetadata();
const result = parseCliArgs(process.argv.slice(2));

if (result.kind === "help") {
  process.stdout.write(helpText(metadata));
} else if (result.kind === "version") {
  process.stdout.write(`${metadata.version}\n`);
} else if (result.kind === "error") {
  process.stderr.write(formatCliError(result.message));
  process.exitCode = 2;
} else if (result.options.prompt !== undefined) {
  const { runPrompt } = await import("./headless");
  process.exitCode = await runPrompt({
    prompt: result.options.prompt,
    resume: result.options.resume,
  });
} else {
  const { start } = await import("./main");
  await start(result.options);
}
