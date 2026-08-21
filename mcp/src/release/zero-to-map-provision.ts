export const AWS_ECS_PROVISION_BINDING_SCHEMA = "honua.aws-ecs.provision-binding/v1" as const;

export interface AwsEcsProvisionBinding {
  readonly schemaVersion: typeof AWS_ECS_PROVISION_BINDING_SCHEMA;
  readonly target: "aws-ecs";
  readonly status: "ready";
  readonly candidateId: string;
  readonly releaseId: string;
  readonly endpoint: string;
  readonly adminKeySecretRef: string;
  readonly serverImage: string;
  readonly components: Readonly<Record<"honua-server" | "honua-devops" | "honua-iac", string>>;
  readonly checks: Readonly<Record<"terraform-plan" | "terraform-apply" | "readiness" | "admin-mcp-handoff", "passed">>;
  readonly evidence: {
    readonly url: string;
    readonly sha256: string;
  };
}

/** Strictly parse the producer-owned pre-teardown binding without importing a second provisioner. */
export function parseAwsEcsProvisionBinding(value: unknown): AwsEcsProvisionBinding {
  const binding = object(value, "AWS ECS provision binding");
  exactKeys(
    binding,
    [
      "schemaVersion",
      "target",
      "status",
      "candidateId",
      "releaseId",
      "endpoint",
      "adminKeySecretRef",
      "serverImage",
      "components",
      "checks",
      "evidence",
    ],
    "AWS ECS provision binding",
  );
  if (binding.schemaVersion !== AWS_ECS_PROVISION_BINDING_SCHEMA) {
    throw new Error(`AWS ECS provision binding schemaVersion must be ${AWS_ECS_PROVISION_BINDING_SCHEMA}`);
  }
  if (binding.target !== "aws-ecs" || binding.status !== "ready") {
    throw new Error("AWS ECS provision binding must target aws-ecs with ready status");
  }
  const candidateId = pattern(
    binding.candidateId,
    /^manifest-sha256:[0-9a-f]{64}$/,
    "AWS ECS provision binding candidateId",
  );
  const releaseId = text(binding.releaseId, "AWS ECS provision binding releaseId");
  const endpoint = publicHttps(binding.endpoint, "AWS ECS provision binding endpoint");
  const adminKeySecretRef = pattern(
    binding.adminKeySecretRef,
    /^arn:aws(?:-us-gov|-cn)?:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/,
    "AWS ECS provision binding adminKeySecretRef",
  );
  const serverImage = pattern(
    binding.serverImage,
    /^ghcr\.io\/honua-io\/honua-server:[^@]+@sha256:[0-9a-f]{64}$/,
    "AWS ECS provision binding serverImage",
  );
  const components = object(binding.components, "AWS ECS provision binding components");
  exactKeys(components, ["honua-server", "honua-devops", "honua-iac"], "AWS ECS provision binding components");
  const checks = object(binding.checks, "AWS ECS provision binding checks");
  exactKeys(
    checks,
    ["terraform-plan", "terraform-apply", "readiness", "admin-mcp-handoff"],
    "AWS ECS provision binding checks",
  );
  for (const name of ["terraform-plan", "terraform-apply", "readiness", "admin-mcp-handoff"] as const) {
    if (checks[name] !== "passed") throw new Error(`AWS ECS provision binding check ${name} must be passed`);
  }
  const evidence = object(binding.evidence, "AWS ECS provision binding evidence");
  exactKeys(evidence, ["url", "sha256"], "AWS ECS provision binding evidence");

  return {
    schemaVersion: AWS_ECS_PROVISION_BINDING_SCHEMA,
    target: "aws-ecs",
    status: "ready",
    candidateId,
    releaseId,
    endpoint,
    adminKeySecretRef,
    serverImage,
    components: {
      "honua-server": revision(components["honua-server"], "AWS ECS provision binding honua-server SHA"),
      "honua-devops": revision(components["honua-devops"], "AWS ECS provision binding honua-devops SHA"),
      "honua-iac": revision(components["honua-iac"], "AWS ECS provision binding honua-iac SHA"),
    },
    checks: {
      "terraform-plan": "passed",
      "terraform-apply": "passed",
      readiness: "passed",
      "admin-mcp-handoff": "passed",
    },
    evidence: {
      url: publicHttps(evidence.url, "AWS ECS provision binding evidence.url"),
      sha256: pattern(evidence.sha256, /^[0-9a-f]{64}$/, "AWS ECS provision binding evidence.sha256"),
    },
  };
}

export function assertAwsEcsProvisionBindings(
  binding: AwsEcsProvisionBinding,
  expected: { readonly candidateId: string; readonly releaseId: string; readonly mcpUrl: string },
): void {
  if (binding.candidateId !== expected.candidateId) throw new Error("AWS ECS provision candidateId mismatch");
  if (binding.releaseId !== expected.releaseId) throw new Error("AWS ECS provision releaseId mismatch");
  const expectedMcp = `${binding.endpoint.replace(/\/$/, "")}/mcp`;
  if (normalizeUrl(expected.mcpUrl) !== normalizeUrl(expectedMcp)) {
    throw new Error("AWS ECS provision endpoint does not match --mcp-url");
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("AWS ECS --mcp-url must be a public HTTPS URL without credentials");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function publicHttps(value: unknown, path: string): string {
  const result = text(value, path);
  const url = new URL(result);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error(`${path} must be a public HTTPS URL without credentials`);
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("169.254.") ||
    host.startsWith("192.168.") ||
    /^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^(?:fc|fd)[0-9a-f]{2}:/.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host)
  ) {
    throw new Error(`${path} must not use a loopback or private endpoint`);
  }
  return result;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = Object.keys(value);
  const missing = allowed.filter((key) => !keys.includes(key));
  const extras = keys.filter((key) => !allowed.includes(key));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `${path} fields are not exact (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`,
    );
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function pattern(value: unknown, regex: RegExp, path: string): string {
  const result = text(value, path);
  if (!regex.test(result)) throw new Error(`${path} has an invalid format`);
  return result;
}

function revision(value: unknown, path: string): string {
  return pattern(value, /^[0-9a-f]{40}$/, path);
}
