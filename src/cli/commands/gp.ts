import { spawn } from "node:child_process";

/** Invoke the separately installed GP developer engine, never a server backend. */
export function gpCommand(args: ReadonlyArray<string>): Promise<number> {
  const executable = process.env.HONUA_GP_CLI?.trim() || "honua-gp-devkit";
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { stdio: "inherit", shell: false });
    child.once("error", () => {
      process.stderr.write(
        "error: honua gp requires the separately installed Honua.Geoprocessing.Cli devkit. " +
          "Put honua-gp-devkit on PATH or set HONUA_GP_CLI to its executable path. " +
          "See https://docs.honua.io/guides/query-analyze/gp-devkit-authoring\n",
      );
      resolve(127);
    });
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}
