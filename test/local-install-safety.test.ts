import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/control-plane/generated/admin-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control-plane/generated/admin-operations.js")>()),
  ADMIN_RELEASE_CONTRACT_COMPATIBLE: true,
}));

import { installHonuaLocal, renderLocalCompose } from "../src/local-install.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "honua-installer-safety-"));
  directories.push(directory);
  return directory;
}
const failAtUp = async (_command: string, args: readonly string[]) => ({
  exitCode: args.includes("up") ? 1 : 0,
  stdout: "",
  stderr: "deliberate stop before containers start",
});

describe("local installer file and project safety", () => {
  it.each(["compose.yaml", "postgis-bootstrap.sql", ".env"])(
    "preserves foreign %s before invoking Docker",
    async (file) => {
      const directory = temporaryDirectory();
      const target = path.join(directory, file);
      writeFileSync(target, "UNRELATED_SECRET=keep-me\n", { mode: 0o600 });
      const run = vi.fn(failAtUp);
      await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow(/Refusing to overwrite/);
      expect(readFileSync(target, "utf8")).toBe("UNRELATED_SECRET=keep-me\n");
      expect(run).not.toHaveBeenCalled();
      expect(readdirSync(directory)).toEqual([file]);
    },
  );

  it.each(["version", "compose"])("writes nothing when Docker %s preflight fails", async (failure) => {
    const directory = temporaryDirectory();
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({
      exitCode: args[0] === failure ? 1 : 0,
      stdout: "",
      stderr: "unavailable",
    }));
    await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow(/unavailable/);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("preserves unrelated environment keys and reuses project identity on retry", async () => {
    const directory = temporaryDirectory();
    await expect(installHonuaLocal({ directory }, { run: failAtUp })).rejects.toThrow();
    const envFile = path.join(directory, ".env");
    const original = readFileSync(envFile, "utf8");
    const unrelated =
      '# consumer settings\nexport EXPORTED="keep=me"\nMULTILINE="first\nsecond"\nCONTINUED=first\\\n  second\nUNRELATED_SECRET="keep=me"\n';
    writeFileSync(envFile, `${original}${unrelated}`);
    chmodSync(envFile, 0o600);
    await expect(installHonuaLocal({ directory }, { run: failAtUp })).rejects.toThrow();
    const next = readFileSync(envFile, "utf8");
    expect(next).toContain(unrelated);
    expect(next).toContain(original);
  });

  it.each(["quickstart", "gp-dev"] as const)(
    "upgrades the known %s edition-grant compose on retry",
    async (profile) => {
      const directory = temporaryDirectory();
      await expect(installHonuaLocal({ directory, profile }, { run: failAtUp })).rejects.toThrow(/deliberate stop/);
      const composeFile = path.join(directory, "compose.yaml");
      const current = readFileSync(composeFile, "utf8");
      const originalEnv = readFileSync(path.join(directory, ".env"), "utf8");
      writeFileSync(
        composeFile,
        current.replace(
          'Licensing__Mode: "Disabled"',
          `Licensing__DevGrantEdition: "${profile === "gp-dev" ? "Pro" : ""}"`,
        ),
      );
      await expect(installHonuaLocal({ directory, profile }, { run: failAtUp })).rejects.toThrow(/deliberate stop/);
      expect(readFileSync(composeFile, "utf8")).toBe(current);
      expect(readFileSync(path.join(directory, ".env"), "utf8")).toBe(originalEnv);
    },
  );

  it.each(['Licensing__Mode: "Enabled"', 'Licensing__DevGrantEdition: "Enterprise"'])(
    "preserves an unrecognized licensing configuration: %s",
    async (setting) => {
      const directory = temporaryDirectory();
      await expect(installHonuaLocal({ directory }, { run: failAtUp })).rejects.toThrow(/deliberate stop/);
      const composeFile = path.join(directory, "compose.yaml");
      const custom = readFileSync(composeFile, "utf8").replace('Licensing__Mode: "Disabled"', setting);
      writeFileSync(composeFile, custom);
      const run = vi.fn(failAtUp);
      await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow(/Refusing to overwrite/);
      expect(run).not.toHaveBeenCalled();
      expect(readFileSync(composeFile, "utf8")).toBe(custom);
    },
  );

  it.each(["POSTGRES_PASSWORD=duplicate\n", "export HONUA_ADMIN_KEY=ambiguous\n", 'HONUA_ADMIN_KEY="multi\nline"\n'])(
    "refuses ambiguous managed assignments without changing files: %s",
    async (extra) => {
      const directory = temporaryDirectory();
      await expect(installHonuaLocal({ directory }, { run: failAtUp })).rejects.toThrow();
      const envFile = path.join(directory, ".env");
      const original = `${readFileSync(envFile, "utf8")}${extra}`;
      writeFileSync(envFile, original);
      const run = vi.fn(failAtUp);
      await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow(/ambiguous installer-managed/);
      expect(run).not.toHaveBeenCalled();
      expect(readFileSync(envFile, "utf8")).toBe(original);
    },
  );

  it("isolates new installs, including recreation at the same directory", async () => {
    const directory = temporaryDirectory();
    const run = vi.fn(failAtUp);
    await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow();
    const original = readFileSync(path.join(directory, ".env"), "utf8").match(/^HONUA_COMPOSE_PROJECT=(.+)$/m)?.[1];
    expect(run).toHaveBeenCalledWith("docker", expect.arrayContaining(["--project-name", original]), directory);
    const secondDirectory = temporaryDirectory();
    await expect(installHonuaLocal({ directory: secondDirectory }, { run: failAtUp })).rejects.toThrow();
    const second = readFileSync(path.join(secondDirectory, ".env"), "utf8").match(/^HONUA_COMPOSE_PROJECT=(.+)$/m)?.[1];
    expect(second).not.toBe(original);
    rmSync(directory, { recursive: true });
    await expect(installHonuaLocal({ directory }, { run: failAtUp })).rejects.toThrow();
    const recreated = readFileSync(path.join(directory, ".env"), "utf8").match(/^HONUA_COMPOSE_PROJECT=(.+)$/m)?.[1];
    expect(original).toMatch(/^honua-local-[a-f0-9]{24}$/);
    expect(recreated).not.toBe(original);
  });

  it.each([
    "foreign",
    "missing",
    "mixed",
    "ambiguous",
    "volumes-only",
    "volume-probe-failure",
    "container-probe-failure",
    "ambiguous-volume-output",
  ])("refuses copied persisted project identity with %s ownership before changing files", async (scenario) => {
    const originalDirectory = temporaryDirectory();
    await expect(installHonuaLocal({ directory: originalDirectory }, { run: failAtUp })).rejects.toThrow();
    const directory = temporaryDirectory();
    for (const file of readdirSync(originalDirectory)) {
      copyFileSync(path.join(originalDirectory, file), path.join(directory, file));
    }
    chmodSync(path.join(directory, ".env"), 0o600);
    const before = Object.fromEntries(
      readdirSync(directory).map((file) => [file, readFileSync(path.join(directory, file), "utf8")]),
    );
    const project = before[".env"].match(/^HONUA_COMPOSE_PROJECT=(.+)$/m)?.[1];
    const rows: Record<string, string> = {
      foreign: `container-a\t${originalDirectory}\n`,
      missing: "container-a\t\n",
      mixed: `container-a\t${directory}\ncontainer-b\t\n`,
      ambiguous: `container-a\t${directory}\tunexpected\n`,
    };
    const run = vi.fn(async (command: string, args: readonly string[]) => {
      if (args[0] === "ps")
        return {
          exitCode: scenario === "container-probe-failure" ? 1 : 0,
          stdout: rows[scenario] ?? "",
          stderr: "private daemon detail",
        };
      if (args[0] === "volume")
        return {
          exitCode: scenario === "volume-probe-failure" ? 1 : 0,
          stdout:
            scenario === "volume-probe-failure"
              ? ""
              : scenario === "ambiguous-volume-output"
                ? " \n"
                : "orphaned-volume\n",
          stderr: "private daemon detail",
        };
      return failAtUp(command, args);
    });
    await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow(
      /ownership could not be verified|another directory or could not be verified/,
    );
    expect(run).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([`label=com.docker.compose.project=${project}`]),
      process.cwd(),
    );
    expect(run.mock.calls.some(([, args]) => args.includes("up"))).toBe(false);
    expect(
      Object.fromEntries(
        readdirSync(directory).map((file) => [file, readFileSync(path.join(directory, file), "utf8")]),
      ),
    ).toEqual(before);
  });

  it("reuses a persisted generated identity when all containers belong to the same directory", async () => {
    const directory = temporaryDirectory();
    await expect(installHonuaLocal({ directory }, { run: failAtUp })).rejects.toThrow();
    const original = readFileSync(path.join(directory, ".env"), "utf8");
    const project = original.match(/^HONUA_COMPOSE_PROJECT=(.+)$/m)?.[1];
    const run = vi.fn(async (command: string, args: readonly string[]) =>
      args[0] === "ps"
        ? { exitCode: 0, stdout: `container-a\t${directory}\ncontainer-b\t${directory}\n`, stderr: "" }
        : failAtUp(command, args),
    );
    await expect(installHonuaLocal({ directory }, { run })).rejects.toThrow(/deliberate stop/);
    expect(run.mock.calls.some(([, args]) => args[0] === "volume")).toBe(false);
    expect(run).toHaveBeenCalledWith("docker", expect.arrayContaining(["--project-name", project, "up"]), directory);
    expect(readFileSync(path.join(directory, ".env"), "utf8")).toBe(original);
  });

  it("retains legacy volumes only when containers belong to this directory", async () => {
    const directory = temporaryDirectory();
    const legacy = renderLocalCompose({ profile: "quickstart" }).replace(
      "# Generated by @honua/sdk-js local installer\nname: ${HONUA_COMPOSE_PROJECT:?Missing installer project identity}",
      "name: honua-local",
    );
    writeFileSync(path.join(directory, "compose.yaml"), legacy);
    writeFileSync(
      path.join(directory, ".env"),
      "HONUA_SERVER_IMAGE=old\nPOSTGRES_PASSWORD=original\nHONUA_ADMIN_PASSWORD=original-admin\nHONUA_CONNECTION_ENCRYPTION_MASTER_KEY=original-master\n",
      { mode: 0o600 },
    );
    const foreign = async (_command: string, args: readonly string[]) =>
      args[0] === "ps"
        ? { exitCode: 0, stdout: "container-a\t/another-install\n", stderr: "" }
        : failAtUp(_command, args);
    await expect(installHonuaLocal({ directory }, { run: foreign })).rejects.toThrow(/another directory/);
    expect(readFileSync(path.join(directory, "compose.yaml"), "utf8")).toBe(legacy);
    const mixed = async (_command: string, args: readonly string[]) =>
      args[0] === "ps"
        ? { exitCode: 0, stdout: `container-a\t${directory}\ncontainer-b\t\n`, stderr: "private daemon details" }
        : failAtUp(_command, args);
    await expect(installHonuaLocal({ directory }, { run: mixed })).rejects.toThrow(/could not be verified/);
    expect(readFileSync(path.join(directory, "compose.yaml"), "utf8")).toBe(legacy);
    expect(readFileSync(path.join(directory, ".env"), "utf8")).not.toContain("HONUA_COMPOSE_PROJECT=");
    const owned = async (_command: string, args: readonly string[]) =>
      args[0] === "ps" ? { exitCode: 0, stdout: `container-a\t${directory}\n`, stderr: "" } : failAtUp(_command, args);
    await expect(installHonuaLocal({ directory }, { run: owned })).rejects.toThrow(/deliberate stop/);
    expect(readFileSync(path.join(directory, ".env"), "utf8")).toContain("HONUA_COMPOSE_PROJECT=honua-local");
    expect(readFileSync(path.join(directory, ".env"), "utf8")).toContain("POSTGRES_PASSWORD=original");
  });
});
