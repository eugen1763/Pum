/**
 * Check mode identity and canonical-input helpers.
 *
 * Check mode is a single on/off toggle. The former ask-mode approval store and
 * popup coordinator were removed with the ask and strict profiles. This module
 * keeps only the identity model and the canonical serializer that the check
 * pipeline still uses to distinguish the main agent from a managed subagent and
 * to compute a stable input digest.
 */

export type CheckedToolName = "bash" | "edit" | "apply_patch";
export type CheckApprovalIdentity =
  | { kind: "main" }
  | { kind: "subagent"; agentId: string };

export function checkApprovalIdentityKey(identity: CheckApprovalIdentity): string {
  return identity.kind === "main" ? "main" : `subagent:${identity.agentId}`;
}

export function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite canonical input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cyclic canonical input");
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cyclic canonical input");
    seen.add(value);
    const object = value as Record<string, unknown>;
    const result = `{${Object.keys(object).sort().map((key) => {
      if (object[key] === undefined) throw new TypeError("Undefined canonical input");
      return `${JSON.stringify(key)}:${canonicalJson(object[key], seen)}`;
    }).join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new TypeError("Unsupported canonical input");
}
