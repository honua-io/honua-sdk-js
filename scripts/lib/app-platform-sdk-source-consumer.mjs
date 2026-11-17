import fs from "node:fs";
import path from "node:path";

const SPLIT_PACKAGES = [
  ["@honua/app-platform", "honua-app-platform"],
  ["@honua/sdk", "honua-sdk"],
];

// The app-platform consumer sits inside the packed @honua/sdk-js consumer, so
// @honua/sdk-js resolves to the installed tarball and the split packages to
// their generated directories.
export function prepareAppPlatformSdkSourceConsumer({ projectRoot, consumerRoot }) {
  const splitRoot = path.join(projectRoot, "dist", "packages");
  const missing = SPLIT_PACKAGES.filter(([, directory]) => !fs.existsSync(path.join(splitRoot, directory, "package.json")));
  if (missing.length > 0) {
    throw new Error(
      `split packages not built (${missing.map(([name]) => name).join(", ")}); run npm run build:split-packages:prepared first`,
    );
  }
  const sampleRoot = path.join(consumerRoot, "app-platform-sdk-source");
  for (const [name, directory] of SPLIT_PACKAGES) {
    fs.cpSync(path.join(splitRoot, directory), path.join(sampleRoot, "node_modules", name), { recursive: true });
  }
  fs.copyFileSync(
    path.join(projectRoot, "test", "fixtures", "packed-app-platform-sdk-source.ts"),
    path.join(sampleRoot, "consumer.ts"),
  );
  const compilerOptions = {
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: "ES2022",
    types: [],
  };
  fs.writeFileSync(
    path.join(sampleRoot, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions, files: ["consumer.ts"] }, null, 2)}\n`,
  );
  return sampleRoot;
}
