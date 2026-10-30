import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(path.resolve("README.md"), "utf8");

function bashFence(command: string): string {
  const fences = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const fence = fences.find((body) => body.includes(command));
  expect(fence, `bash fence containing ${command}`).toBeDefined();
  return fence ?? "";
}

describe("README geoprocessing commands", () => {
  it("installs the published CLI and honua-gp-devkit before honua gp", () => {
    const fence = bashFence("honua gp doctor --managed-only --json");
    const doctor = fence.indexOf("honua gp doctor --managed-only --json");
    const cli = fence.indexOf("npm i -g @honua/sdk-js");
    const devkit = fence.indexOf("dotnet tool install Honua.Geoprocessing.Cli");
    const onPath = fence.indexOf('export PATH="$PWD/honua-gp:$PATH"');
    expect(cli).toBeGreaterThanOrEqual(0);
    expect(devkit).toBeGreaterThanOrEqual(0);
    expect(onPath).toBeGreaterThanOrEqual(0);
    expect(cli).toBeLessThan(doctor);
    expect(devkit).toBeLessThan(doctor);
    expect(onPath).toBeLessThan(doctor);
    expect(fence.indexOf("honua gp list --json")).toBeGreaterThan(doctor);
    expect(fence.indexOf("honua gp describe geometry.buffer --json")).toBeGreaterThan(doctor);
  });
});
