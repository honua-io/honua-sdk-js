import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const frontmatterSchema = z.looseObject({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
  release: z.string().min(1),
});

export interface SkillFile {
  uri: string;
  digest: string;
  size: number;
  bytes: Buffer;
}

export interface SdkSkill {
  uri: string;
  frontmatter: z.infer<typeof frontmatterSchema>;
  resources: SkillFile[];
  sdkVersion: string;
  text: string;
}

export function installedSdkRoot(): string {
  let directory = dirname(createRequire(import.meta.url).resolve("@honua/sdk-js"));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@honua/sdk-js") {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the installed @honua/sdk-js package");
    directory = parent;
  }
}

export function loadSdkSkills(packageRoot = installedSdkRoot()): SdkSkill[] {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@honua/sdk-js" || typeof manifest.version !== "string") {
    throw new Error("Skills must come from a versioned @honua/sdk-js installation");
  }
  const skillsRoot = join(packageRoot, "skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Skill directory cannot be a symlink: ${entry.name}`);
      if (!entry.isDirectory()) return [];
      return [loadSkill(join(skillsRoot, entry.name), manifest.version)];
    });
}

function loadSkill(directory: string, sdkVersion: string): SdkSkill {
  const name = basename(directory);
  const resources = loadFiles({ directory, uri: `skill://${name}` });
  const uri = `skill://${name}/SKILL.md`;
  const file = resources.find((entry) => entry.uri === uri);
  if (!file) throw new Error(`Missing SKILL.md in ${name}`);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Missing YAML frontmatter in ${name}`);
  const fields = parse(match[1], { maxAliasCount: 0 });
  z.json().parse(fields);
  const frontmatter = frontmatterSchema.parse(fields);
  if (frontmatter.name !== name) throw new Error(`Skill name does not match directory: ${name}`);
  return { uri, frontmatter, resources, sdkVersion, text };
}

function loadFiles(location: { directory: string; uri: string }): SkillFile[] {
  return readdirSync(location.directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const directory = join(location.directory, entry.name);
      const uri = `${location.uri}/${encodeURIComponent(entry.name)}`;
      if (entry.isDirectory()) return loadFiles({ directory, uri });
      if (!entry.isFile()) throw new Error(`Skill resources must be regular files: ${directory}`);
      const bytes = readFileSync(directory);
      return [{ uri, bytes, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }];
    });
}
