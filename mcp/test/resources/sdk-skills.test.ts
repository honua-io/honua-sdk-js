import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { createFixtureClient } from "../../src/certification/fixture-client.js";
import { createBootstrapServer, createServer } from "../../src/index.js";
import { installedSdkRoot, loadSdkSkills } from "../../src/resources/sdk-skills-catalog.js";
import { SKILLS_EXTENSION } from "../../src/resources/sdk-skills.js";

const skillSchema = z.object({
  uri: z.string(),
  frontmatter: z.looseObject({ name: z.string(), description: z.string(), release: z.string() }),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
  _meta: z.object({ "io.honua/sdkVersion": z.string() }),
});
const listSchema = z.object({ resultType: z.literal("complete"), skills: z.array(skillSchema) });
const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function connectServer(factory = () => createServer(createFixtureClient())) {
  const server = factory();
  const client = new Client({ name: "skills-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function assertInstalledSkill(client: Client, root: string, name: string) {
  const uri = `skill://${name}/SKILL.md`;
  const loaded = await client.request({ method: "skills/get", params: { uri } }, z.object({ skill: skillSchema }));
  const bytes = readFileSync(join(root, "skills", name, "SKILL.md"));
  expect(loaded.skill.frontmatter).toEqual(parse(bytes.toString("utf8").split("---")[1]));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  expect(loaded.skill._meta["io.honua/sdkVersion"]).toBe(version);
  expect(loaded.skill.resources).toContainEqual({
    uri,
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  const resource = await client.readResource({ uri });
  expect(Buffer.from(String(resource.contents[0].text))).toEqual(bytes);
  return loaded.skill;
}

describe("installed SDK skills over MCP", () => {
  it("lists exactly the installed skill set and loads identical bytes by name", async () => {
    const { client, close } = await connectServer();
    try {
      expect(client.getServerCapabilities()?.extensions).toHaveProperty(SKILLS_EXTENSION);
      const result = await client.request({ method: "skills/list" }, listSchema);
      const root = installedSdkRoot();
      const names = readdirSync(join(root, "skills"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(result.skills.map((skill) => skill.frontmatter.name).sort()).toEqual(names);
      for (const name of names) {
        const loaded = await assertInstalledSkill(client, root, name);
        expect(loaded).toEqual(result.skills.find((skill) => skill.uri === loaded.uri));
      }
      const resources = await client.listResources();
      expect(
        resources.resources
          .filter((entry) => entry.uri.startsWith("skill://"))
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(names);
    } finally {
      await close();
    }
  });

  it("offers ordinary resources on bootstrap and rejects unknown skills and cursors", async () => {
    const { client, close } = await connectServer(createBootstrapServer);
    try {
      const result = await client.request({ method: "skills/list", params: {} }, listSchema);
      expect(result.skills.length).toBeGreaterThan(0);
      const body = await client.readResource({ uri: result.skills[0].uri });
      expect(body.contents[0].mimeType).toBe("text/markdown");
      for (const uri of ["skill://missing/SKILL.md", "file:///etc/passwd", "skill://connect-data/../../package.json"]) {
        await expect(client.request({ method: "skills/get", params: { uri } }, z.object({}))).rejects.toThrow(/-32602/);
        await expect(client.readResource({ uri })).rejects.toThrow();
      }
      await expect(client.request({ method: "skills/list", params: { cursor: "stale" } }, listSchema)).rejects.toThrow(
        /-32602/,
      );
    } finally {
      await close();
    }
  });
});

function fixture(body = "---\nname: example\ndescription: An example\nrelease: '2026.1'\n---\nBody\n") {
  const root = mkdtempSync(join(tmpdir(), "honua-sdk-skills-"));
  scratch.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@honua/sdk-js", version: "0.3.3" }));
  mkdirSync(join(root, "skills", "example"), { recursive: true });
  writeFileSync(join(root, "skills", "example", "SKILL.md"), body);
  return root;
}

describe("SDK skill catalog validation", () => {
  it("preserves YAML metadata, CRLF bytes and supporting file manifests", () => {
    const body =
      '---\r\nname: example\r\ndescription: >-\r\n  A multi-line\r\n  description\r\nrelease: "2026.1"\r\nstages: [build, check]\r\n---\r\nBody\r\n';
    const root = fixture(body);
    const binary = Buffer.from([0, 255, 42]);
    writeFileSync(join(root, "skills", "example", "sample.bin"), binary);
    const [skill] = loadSdkSkills(root);
    expect(skill.text).toBe(body);
    expect(skill.frontmatter).toMatchObject({ description: "A multi-line description", stages: ["build", "check"] });
    expect(skill.resources.find((file) => file.uri.endsWith("sample.bin"))).toMatchObject({ bytes: binary, size: 3 });
  });

  it("removes an entry when removed from the installed SDK and supports older packages without skills", () => {
    const root = fixture();
    expect(loadSdkSkills(root).map((skill) => skill.frontmatter.name)).toEqual(["example"]);
    rmSync(join(root, "skills", "example"), { recursive: true });
    expect(loadSdkSkills(root)).toEqual([]);
    rmSync(join(root, "skills"), { recursive: true });
    expect(loadSdkSkills(root)).toEqual([]);
  });

  it.each([
    "No frontmatter",
    "---\nname: mismatch\ndescription: Example\nrelease: '2026.1'\n---\n",
    "---\nname: example\ndescription: Example\n---\n",
  ])("rejects invalid published metadata: %s", (body) => {
    expect(() => loadSdkSkills(fixture(body))).toThrow();
  });

  it("rejects symlink resources and invalid UTF-8 rather than serving altered bytes", () => {
    const root = fixture();
    const file = join(root, "skills", "example", "SKILL.md");
    writeFileSync(file, Buffer.from([255]));
    expect(() => loadSdkSkills(root)).toThrow();
    rmSync(file);
    symlinkSync(join(root, "package.json"), file);
    expect(() => loadSdkSkills(root)).toThrow(/regular files/);
  });
});
