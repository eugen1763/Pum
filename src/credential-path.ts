const CREDENTIAL_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".pypirc", ".netrc",
  "credentials", "credentials.json", "auth.json", "id_rsa", "id_ed25519", "known_hosts",
]);

export function isCredentialSensitivePath(value: string): boolean {
  const lower = value.toLowerCase().replaceAll("\\", "/");
  const segments = lower.split("/").filter(Boolean);
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  return segments.some((segment) => /^\.env(?:\..+)?$/.test(segment))
    || lower.includes("secrets/") || lower.endsWith("/shadow") || lower.endsWith("/passwd");
}
