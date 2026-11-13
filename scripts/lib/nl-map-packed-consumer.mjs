import fs from "node:fs";
import path from "node:path";

export function prepareNlMapConsumer({ projectRoot, consumerRoot }) {
  const sourceRoot = path.join(projectRoot, "examples", "nl-map-control");
  const sampleRoot = path.join(consumerRoot, "nl-map-control");
  fs.mkdirSync(sampleRoot);
  for (const name of ["src", "index.html", "evaluation.v1.json"]) {
    fs.cpSync(path.join(sourceRoot, name), path.join(sampleRoot, name), { recursive: true });
  }
  const { compilerOptions } = JSON.parse(fs.readFileSync(path.join(sourceRoot, "tsconfig.json"), "utf8"));
  delete compilerOptions.paths;
  delete compilerOptions.baseUrl;
  fs.writeFileSync(
    path.join(sampleRoot, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(sampleRoot, "vite.config.mjs"),
    'export default { base: "./", build: { outDir: "dist" } };\n',
  );
  for (const name of ["vite", "@types/geojson"]) {
    const target = path.join(consumerRoot, "node_modules", name);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(
      path.join(projectRoot, "node_modules", name), target,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  return sampleRoot;
}
