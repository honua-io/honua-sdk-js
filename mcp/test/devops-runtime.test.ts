import { describe, expect, it } from "vitest";
import { type DevOpsProcessConfiguration, createDevOpsExtension } from "../src/agent/devops-runtime.js";

// Wire-level child process: exercises real stdio framing, initialization and pagination.
// This fixture is protocol evidence, not a qualified AWS deployment.
const fixture = `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); if (!('id' in m)) return;
  let result;
  const tool = name => ({name,description:'canonical contract',inputSchema:{type:'object',properties:{stack:{type:'string'}}},annotations:{readOnlyHint:false},_meta:{contract:'v1'}});
  if(m.method === 'initialize') result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{},...(process.env.HONUA_DEVOPS_TURN_CAPABILITY === '1' ? {experimental:{'honua.io/devops-turn-binding':{version:1}}} : {})},serverInfo:{name:'fixture',version:'1'}};
  if(m.method === 'tools/list') result=m.params?.cursor ? {tools:[tool('provision_infrastructure'),tool('record_gitops_proposal_decision'),tool('install_handoff'),tool('verify_install_handoff')]} : {tools:[tool('describe_environment')],nextCursor:'page2'};
  if(m.method === 'tools/call') {
    if(m.params.arguments.disconnect) { process.exit(0); }
    if(m.params.arguments.fail) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:process.env.HONUA_DEVOPS_API_KEY}})+'\\n'); return; }
    result={content:[{type:'text',text:process.env.HONUA_DEVOPS_API_KEY + ':' + process.env.HONUA_ADMIN_KEY}],structuredContent:{name:m.params.name,args:m.params.arguments},_meta:{canonical:'operation-123'}};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;

function extension(
  authorize = async (_action: { canonicalTool: string | null }) => {},
  overrides: Partial<DevOpsProcessConfiguration> = {},
) {
  return createDevOpsExtension(
    {
      command: process.execPath,
      args: ["-e", fixture],
      env: { HONUA_DEVOPS_API_KEY: "sentinel-secret-123", HONUA_ADMIN_KEY: "sentinel-admin-key-456" },
      provisioningScope: {
        environment: "dev",
        region: "us-west-2",
        namePrefix: "approved-cell",
        allowedImages: ["honua@sha256:approved"],
      },
      ...overrides,
    },
    authorize,
  );
}

describe("optional private DevOps runtime", () => {
  it("refuses an older child for turn-bound private discovery and accepts an advertised bound child", async () => {
    const old = extension(async () => {}, { requireTurnBindingCapability: true });
    try {
      await expect(old.listTools()).rejects.toThrow("discovery unavailable or unauthorized");
      await expect(old.callTool("honua_agent_devops_describe_environment", {})).rejects.toThrow(
        "failed or unauthorized",
      );
    } finally {
      await old.close();
    }
    const current = extension(async () => {}, {
      requireTurnBindingCapability: true,
      env: { HONUA_DEVOPS_TURN_CAPABILITY: "1" },
    });
    try {
      expect((await current.listTools()).some((tool) => tool.name === "honua_agent_devops_describe_environment")).toBe(
        true,
      );
    } finally {
      await current.close();
    }
  });
  it.each([
    ["aws-lambda", "honua_image_uri"],
    ["aws-eks", undefined],
  ] as const)("keeps %s provisioning inside the host-selected runtime", async (runtimeKind, imageVariable) => {
    const runtime = extension(async () => {}, { runtimeKind });
    try {
      const result = await runtime.callTool("honua_agent_devops_provision_infrastructure", { stack: runtimeKind });
      const variables = JSON.parse(String((result.structuredContent?.args as Record<string, unknown>).variablesJson));
      expect(variables).toEqual({
        environment: "dev",
        region: "us-west-2",
        name_prefix: "approved-cell",
        ...(imageVariable ? { [imageVariable]: "honua@sha256:approved" } : {}),
      });
      await expect(
        runtime.callTool("honua_agent_devops_provision_infrastructure", { stack: "aws-ecs" }),
      ).rejects.toThrow("failed or unauthorized");
      for (const variablesJson of [
        '{"region":"other"}',
        '{"honua_image":"honua@sha256:approved"}',
        '{"install":{"artifact":{"image":"unapproved"}}}',
      ]) {
        await expect(
          runtime.callTool("honua_agent_devops_provision_infrastructure", { stack: runtimeKind, variablesJson }),
        ).rejects.toThrow("failed or unauthorized");
      }
    } finally {
      await runtime.close();
    }
  });

  it("checks marketplace image overrides against the approved image scope", async () => {
    const runtime = extension();
    try {
      await expect(
        runtime.callTool("honua_agent_devops_provision_infrastructure", {
          stack: "aws-ecs",
          variablesJson: '{"install":{"artifact":{"image":"unapproved"}}}',
        }),
      ).rejects.toThrow("failed or unauthorized");
      const result = await runtime.callTool("honua_agent_devops_provision_infrastructure", {
        stack: "aws-ecs",
        variablesJson: '{"install":{"artifact":{"image":"honua@sha256:approved"}}}',
      });
      const variables = JSON.parse(String((result.structuredContent?.args as Record<string, unknown>).variablesJson));
      expect(variables.install.artifact.image).toBe("honua@sha256:approved");
    } finally {
      await runtime.close();
    }
  });

  it("projects canonical descriptors through the closed allowlist over real child stdio", async () => {
    const actions: unknown[] = [];
    const runtime = extension(async (action) => {
      actions.push(action);
    });
    try {
      const tools = await runtime.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "honua_agent_devops_describe_environment",
        "honua_agent_devops_provision_infrastructure",
      ]);
      expect(tools[0]).toMatchObject({ description: "canonical contract", _meta: { contract: "v1" } });
      const result = await runtime.callTool("honua_agent_devops_provision_infrastructure", { stack: "aws-ecs" });
      expect(result.structuredContent).toMatchObject({ name: "provision_infrastructure", args: { stack: "aws-ecs" } });
      expect(JSON.parse(String((result.structuredContent?.args as Record<string, unknown>).variablesJson))).toEqual({
        environment: "dev",
        region: "us-west-2",
        name_prefix: "approved-cell",
        honua_image: "honua@sha256:approved",
      });
      expect(result._meta).toEqual({ canonical: "operation-123" });
      expect(JSON.stringify(result)).not.toContain("sentinel-secret-123");
      expect(JSON.stringify(result)).not.toContain("sentinel-admin-key-456");
      expect(actions).toMatchObject([
        { canonicalTool: null },
        { canonicalTool: "provision_infrastructure", arguments: { stack: "aws-ecs" } },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("checks authorization on every discovery and action even after a successful connection", async () => {
    let allowed = true;
    const runtime = extension(async () => {
      if (!allowed) throw new Error("secret principal");
    });
    try {
      await runtime.listTools();
      allowed = false;
      await expect(runtime.listTools()).rejects.toThrow("unavailable or unauthorized");
      await expect(runtime.callTool("honua_agent_devops_describe_environment", {})).rejects.toThrow(
        "failed or unauthorized",
      );
    } finally {
      await runtime.close();
    }
  });

  it("rejects model approval, arbitrary forwarding, and unproved adapters", async () => {
    const runtime = extension();
    try {
      await expect(runtime.callTool("honua_agent_devops_record_gitops_proposal_decision", {})).rejects.toThrow(
        "Unsupported",
      );
      await expect(runtime.callTool("describe_environment", {})).rejects.toThrow("Unsupported");
      await expect(
        runtime.callTool("honua_agent_devops_provision_infrastructure", { stack: "lambda" }),
      ).rejects.toThrow("failed or unauthorized");
    } finally {
      await runtime.close();
    }
  });

  it("sanitizes private failures and fails closed after shutdown", async () => {
    const runtime = extension();
    await expect(runtime.callTool("honua_agent_devops_describe_environment", { fail: true })).rejects.toThrow(
      "reconcile canonical operation state",
    );
    await runtime.close();
    await expect(runtime.listTools()).rejects.toThrow("unavailable or unauthorized");
  });

  it("reconnects later requests after child loss without replaying the failed action", async () => {
    const runtime = extension();
    try {
      await expect(runtime.callTool("honua_agent_devops_describe_environment", { disconnect: true })).rejects.toThrow(
        "reconcile canonical operation state",
      );
      expect((await runtime.listTools()).length).toBe(2);
    } finally {
      await runtime.close();
    }
  });

  it("hides unbound credential paths and rejects cloud target overrides before private dispatch", async () => {
    const runtime = extension();
    try {
      expect((await runtime.listTools()).some((tool) => tool.name.includes("handoff"))).toBe(false);
      await expect(
        runtime.callTool("honua_agent_devops_install_handoff", { outputDirectory: "/model-selected" }),
      ).rejects.toThrow("failed or unauthorized");
      for (const variablesJson of [
        '{"environment":"prod"}',
        '{"region":"other"}',
        '{"name_prefix":"other"}',
        '{"honua_image":"unapproved"}',
      ]) {
        await expect(
          runtime.callTool("honua_agent_devops_provision_infrastructure", { stack: "aws-ecs", variablesJson }),
        ).rejects.toThrow("failed or unauthorized");
      }
    } finally {
      await runtime.close();
    }
  });

  it("injects fixed handoff fields and refuses mismatched paths", async () => {
    const fixed = {
      baseUrl: "https://approved.example",
      adminKeySecretRef: "secret://approved",
      outputDirectory: "/host/handoff",
    };
    const runtime = extension(async () => {}, { fixedArguments: { install_handoff: fixed } });
    try {
      const result = await runtime.callTool("honua_agent_devops_install_handoff", { outputDirectory: "" });
      expect(result.structuredContent).toMatchObject({ args: fixed });
      await expect(
        runtime.callTool("honua_agent_devops_install_handoff", { outputDirectory: "/other" }),
      ).rejects.toThrow("failed or unauthorized");
    } finally {
      await runtime.close();
    }
  });

  it("requires a host-selected absolute executable", () => {
    expect(() => createDevOpsExtension({ command: "honua-devops" }, async () => {})).toThrow("absolute host path");
  });
});

// Opt-in qualification against a built PRIVATE artifact. This performs discovery and a
// read-only planner call only; it never provisions cloud resources or submits operations.
const artifact = process.env.HONUA_DEVOPS_TEST_ARTIFACT;
it.skipIf(!artifact)(
  "connects the real private DevOps artifact and invokes its canonical planner",
  async () => {
    const runtime = createDevOpsExtension(
      {
        command: process.env.HONUA_DEVOPS_TEST_DOTNET ?? artifact ?? "",
        args: process.env.HONUA_DEVOPS_TEST_DOTNET ? [artifact ?? "", "--mcp"] : ["--mcp"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          HONUA_DEVOPS_EXECUTION_MODE: "plan",
          HONUA_DEVOPS_APPROVAL_MODE: "pr-first",
          HONUA_DEVOPS_HONUA_API_BASE_URL: "http://127.0.0.1:9",
          HONUA_DEVOPS_BACKEND_TIMEOUT_SECONDS: "1",
        },
      },
      async () => {},
    );
    try {
      expect((await runtime.listTools()).some((tool) => tool.name === "honua_agent_devops_plan_gitops_engine")).toBe(
        true,
      );
      const result = await runtime.callTool("honua_agent_devops_plan_gitops_engine", {
        service: "honua",
        environmentsCsv: "dev",
        revision: "v1.0.0",
        action: "sync",
        changeSummary: "read-only integration qualification",
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("plan");
    } finally {
      await runtime.close();
    }
  },
  30_000,
);
