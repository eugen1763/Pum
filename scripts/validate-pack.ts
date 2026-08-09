import { $ } from "bun";
import { readdirSync } from "node:fs";
import { relative } from "node:path";

type PackFile = { path: string };
type PackResult = { files: PackFile[] };

const packageJson = await Bun.file("package.json").json() as {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
};

const output = await $`npm pack --dry-run --json`.quiet().text();
const parsed = JSON.parse(output) as PackResult[] | Record<string, PackResult>;
const results = Array.isArray(parsed) ? parsed : Object.values(parsed);
if (results.length !== 1) {
  throw new Error(`Expected one package result, received ${results.length}.`);
}

const packed = new Set(results[0]!.files.map(({ path }) => path));
const runtimeFiles = readdirSync("src", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(process.cwd(), `${entry.parentPath}/${entry.name}`).replaceAll("\\", "/"))
  .filter((path) => /\.(?:ts|tsx)$/.test(path) && !/\.test\.(?:ts|tsx)$/.test(path));

const required = ["package.json", "LICENSE", "README.md", ...runtimeFiles];
const missing = required.filter((path) => !packed.has(path));
if (missing.length > 0) {
  throw new Error(`The package is missing required files:\n${missing.join("\n")}`);
}

const forbidden = [...packed].filter((path) =>
  /(?:^|\/)(?:node_modules|tests?|\.github|\.git)(?:\/|$)/.test(path)
  || /\.test\.(?:ts|tsx)$/.test(path)
  || path === "bun.lock"
  || path === "AGENTS.md"
  || path === "tsconfig.json"
  || path.startsWith("scripts/"),
);
if (forbidden.length > 0) {
  throw new Error(`The package contains forbidden files:\n${forbidden.join("\n")}`);
}

if (packageJson.name !== "pum-agent") {
  throw new Error(`Unexpected package name: ${packageJson.name ?? "missing"}.`);
}
if (!packageJson.version || packageJson.version === "0.0.1") {
  throw new Error(`Invalid release version: ${packageJson.version ?? "missing"}.`);
}
if (packageJson.bin?.pum !== "src/index.tsx") {
  throw new Error("The package must install src/index.tsx as the pum executable.");
}
if (!packed.has(packageJson.bin.pum)) {
  throw new Error("The pum executable is not present in the package.");
}

console.log(`Validated ${packed.size} files for ${packageJson.name}@${packageJson.version}.`);
