import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gpCommand } from "../src/cli/commands/gp.js";
import { run } from "../src/cli/main.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function child() {
  const process = Object.assign(new EventEmitter(), { kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(process as unknown as ReturnType<typeof spawn>);
  return process;
}

describe("GP devkit adapter", () => {
  it("routes the product command before parsing server flags", async () => {
    const process = child();
    const result = run(["gp", "doctor", "--managed-only", "--json"]);
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ["doctor", "--managed-only", "--json"], {
      stdio: "inherit",
      shell: false,
    });
    process.emit("exit", 0, null);
    expect(await result).toBe(0);
  });

  it("preserves literal arguments and nonzero exit codes", async () => {
    vi.stubEnv("HONUA_GP_CLI", "/tools with spaces/devkit");
    const process = child();
    const args = ["run", "geometry.buffer", "--param", "label=$(unsafe)", "--param", "name=a b"];
    const result = gpCommand(args);
    expect(spawn).toHaveBeenCalledWith("/tools with spaces/devkit", args, { stdio: "inherit", shell: false });
    process.emit("exit", 3, null);
    expect(await result).toBe(3);
  });

  it("reports missing engine with installation guidance", async () => {
    vi.stubEnv("HONUA_GP_CLI", "");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const processHandle = child();
    const result = gpCommand(["list"]);
    processHandle.emit("error", new Error("ENOENT"));
    expect(await result).toBe(127);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("honua-gp-devkit"));
  });

  it("maps cancellation to a nonzero exit", async () => {
    const process = child();
    const result = gpCommand(["run"]);
    process.emit("exit", null, "SIGINT");
    expect(await result).toBe(130);
  });

  it("forwards parent termination and removes signal handlers after exit", async () => {
    const before = process.listenerCount("SIGTERM");
    const handle = child();
    const result = gpCommand(["run"]);
    process.emit("SIGTERM");
    expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
    handle.emit("exit", null, "SIGTERM");
    expect(await result).toBe(143);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
