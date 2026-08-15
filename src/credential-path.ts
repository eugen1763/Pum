const CREDENTIAL_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".pypirc", ".netrc",
  ".git-credentials", ".pgpass", ".terraformrc", ".terraform.d", ".boto", ".s3cfg", ".htpasswd",
  "credentials", "credentials.json", ".credentials.json", "credentials.toml", "credentials.tfrc.json",
  "auth.json", "token.json", "rclone.conf", "secrets.json", "secrets.yaml", "secrets.yml",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts",
]);

/** Credential stores that are only sensitive below their owning tool directory. */
const CREDENTIAL_DIRECTORIES = /(?:^|\/)\.config\/(?:gh|glab|gcloud|rclone|doctl|hub)(?:\/|$)/;
/** Private key, certificate, and keystore file names. */
const CREDENTIAL_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".keystore"];

/**
 * Environment variables that make an otherwise safe command execute attacker
 * chosen code. Check mode, the trigger process launcher, and the native sandbox
 * share this one list so a variable can never be denied by only one of them.
 */
const EXECUTION_HIJACK_ENVIRONMENT = new Set([
  "BASH_ENV", "BROWSER", "BUN_OPTIONS", "DENO_FLAGS", "EDITOR", "ENV",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ASKPASS", "GIT_CONFIG", "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_EDITOR", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
  "GIT_PROXY_COMMAND", "GIT_SSH", "GIT_SSH_COMMAND", "NODE_OPTIONS", "PAGER", "PERL5OPT",
  "PROMPT_COMMAND", "PYTHONINSPECT", "PYTHONPATH", "PYTHONSTARTUP", "RUBYOPT", "SHELLOPTS",
  "SSH_ASKPASS", "VISUAL", "ZDOTDIR",
]);

export function isCredentialSensitivePath(value: string): boolean {
  const lower = value.toLowerCase().replaceAll("\\", "/");
  const segments = lower.split("/").filter(Boolean);
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  if (segments.some((segment) => CREDENTIAL_SUFFIXES.some((suffix) => segment.endsWith(suffix)))) return true;
  if (CREDENTIAL_DIRECTORIES.test(lower)) return true;
  return segments.some((segment) => /^\.env(?:\..+)?$/.test(segment))
    || lower.includes("secrets/") || lower.endsWith("/shadow") || lower.endsWith("/passwd");
}

/** Report an environment variable name that can hijack execution of a command. */
export function isExecutionHijackEnvironmentVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return EXECUTION_HIJACK_ENVIRONMENT.has(upper)
    || upper.startsWith("LD_")
    || upper.startsWith("DYLD_")
    || upper.startsWith("GIT_CONFIG_KEY_")
    || upper.startsWith("GIT_CONFIG_VALUE_");
}
