import { spawn, type ChildProcess } from "node:child_process";

const MISSING_ENGINE =
  "error: honua gp requires the separately installed Honua.Geoprocessing.Cli devkit. " +
  "Put honua-gp-devkit on PATH or set HONUA_GP_CLI to its executable path. " +
  "See https://docs.honua.io/guides/query-analyze/gp-devkit-authoring\n";

/** Invoke the separately installed GP developer engine, never a server backend. */
export function gpCommand(args: ReadonlyArray<string>): Promise<number> {
  const executable = process.env.HONUA_GP_CLI?.trim() || "honua-gp-devkit";
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(executable, [...args], { stdio: "inherit", shell: false });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      resolve(code);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      // A failed kill() also emits error, after the process exists. That is not a missing engine.
      if (child.pid !== undefined) {
        process.stderr.write(`error: honua gp could not signal the devkit: ${error.message}\n`);
        return;
      }
      if (error.code === "ENOENT" || error.message === "ENOENT") {
        process.stderr.write(MISSING_ENGINE);
        finish(127);
        return;
      }
      process.stderr.write(`error: honua gp could not start the devkit: ${error.message}\n`);
      finish(126);
    });
    child.once("exit", (code, signal) => {
      finish(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}
