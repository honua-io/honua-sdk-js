import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, RequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type SdkSkill, loadSdkSkills } from "./sdk-skills-catalog.js";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const cache = { resultType: "complete", ttlMs: 0, cacheScope: "public" } as const;
const listRequest = RequestSchema.extend({
  method: z.literal("skills/list"),
  params: z.looseObject({ cursor: z.string().optional() }).optional(),
});
const getRequest = RequestSchema.extend({
  method: z.literal("skills/get"),
  params: z.looseObject({ uri: z.string() }),
});

export function registerSdkSkills(server: McpServer): void {
  const skills = loadSdkSkills();
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } });
  server.server.setRequestHandler(listRequest, async (request) => {
    if (request.params?.cursor !== undefined) throw new McpError(ErrorCode.InvalidParams, "Invalid skills cursor");
    return { ...cache, skills: skills.map(skillEntry) };
  });
  server.server.setRequestHandler(getRequest, async (request) => {
    const skill = skills.find((entry) => entry.uri === request.params.uri);
    if (!skill) throw new McpError(ErrorCode.InvalidParams, `No skill is served at ${request.params.uri}`);
    return { ...cache, skill: skillEntry(skill) };
  });
  for (const skill of skills) registerSkillResources(server, skill);
}

function skillEntry(skill: SdkSkill) {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
    _meta: { "io.honua/sdkVersion": skill.sdkVersion },
  };
}

function registerSkillResources(server: McpServer, skill: SdkSkill): void {
  for (const file of skill.resources) {
    const isSkill = file.uri === skill.uri;
    const mimeType = isSkill ? "text/markdown" : "application/octet-stream";
    server.registerResource(
      isSkill ? skill.frontmatter.name : file.uri,
      file.uri,
      {
        description: isSkill ? skill.frontmatter.description : undefined,
        mimeType,
        size: file.size,
        _meta: { "io.honua/sdkVersion": skill.sdkVersion, "io.honua/release": skill.frontmatter.release },
      },
      async () => ({
        ...cache,
        contents: [
          { uri: file.uri, mimeType, ...(isSkill ? { text: skill.text } : { blob: file.bytes.toString("base64") }) },
        ],
      }),
    );
  }
}
