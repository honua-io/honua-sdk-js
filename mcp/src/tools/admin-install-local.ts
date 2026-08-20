import { type LocalInstallRuntime, installHonuaLocal } from "@honua/sdk-js/local-install";
import { z } from "zod";

export const schema = z.object({
  directory: z.string().min(1).describe("Directory that will own compose.yaml, .env, and MCP configuration."),
  profile: z.enum(["quickstart", "gp-dev"]).default("quickstart"),
  httpPort: z.number().int().min(1).max(65535).default(8080),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(180_000),
  confirm: z.literal(true).describe("Explicit approval to create files and start Docker containers."),
});

export type AdminInstallLocalInput = z.infer<typeof schema>;

export async function execute(input: AdminInstallLocalInput, runtime: LocalInstallRuntime = {}) {
  const result = await installHonuaLocal(
    {
      directory: input.directory,
      profile: input.profile,
      httpPort: input.httpPort,
      timeoutMs: input.timeoutMs,
    },
    runtime,
  );
  const structuredContent: Record<string, unknown> = { ...result };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent,
  };
}
