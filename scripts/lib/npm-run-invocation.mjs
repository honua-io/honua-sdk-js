const ALLOWED_SCRIPTS = new Set(["build", "compile"]);

export function resolveNpmRunInvocation(buildScript, options = {}) {
  if (!ALLOWED_SCRIPTS.has(buildScript)) {
    throw new Error(`Unsupported build script ${buildScript}`);
  }
  const platform = options.platform ?? process.platform;
  return {
    command: "npm",
    args: ["run", buildScript, "--silent"],
    shell: platform === "win32",
  };
}
