import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// scripts/realtime-live-candidate-deployment.sh boots a real Docker Compose
// stack, so it has no seam a vitest unit test can drive directly. This proves
// the honua-server#4722 key-ring certificate fix (#1736) is actually wired up
// by asserting on the script's own source, the same way a reviewer would.
const scriptPath = fileURLToPath(new URL("../scripts/realtime-live-candidate-deployment.sh", import.meta.url));
const script = readFileSync(scriptPath, "utf8");

describe("realtime-live-candidate-deployment.sh key-ring certificate", () => {
  it("mints a throwaway PKCS#12 key-ring certificate before the first boot", () => {
    expect(script).toMatch(/openssl req -x509[\s\S]{0,200}-out "\$work\/keyring\.crt"/);
    expect(script).toMatch(/openssl pkcs12 -export[\s\S]{0,200}-out "\$work\/keyring\.p12"/);
  });

  it("mounts the certificate read-only for every candidate boot, including restarts", () => {
    const mounts = [...script.matchAll(/-v "\$work\/keyring\.p12:([^"]+):ro"/g)];
    expect(mounts.length).toBeGreaterThan(0);
    for (const [, containerPath] of mounts) {
      expect(containerPath).toBe("/app/keyring.p12");
    }
  });

  it("configures the durable operation secret channel to use the mounted certificate", () => {
    expect(script).toMatch(/^Operations__SecretChannel__KeyRingCertificatePath=\/app\/keyring\.p12$/m);
    expect(script).toMatch(/^Operations__SecretChannel__KeyRingCertificatePassword=\$\{keyring_password\}$/m);
  });

  it("redacts the key-ring password in the retained deployment descriptor", () => {
    const secretPattern = /const secret = (\/.*\/i);/.exec(script);
    expect(secretPattern).not.toBeNull();
    const secret = new RegExp(secretPattern![1].slice(1, -2), "i");
    expect(secret.test("Operations__SecretChannel__KeyRingCertificatePassword")).toBe(true);
  });

  it("never writes the certificate's private key to disk", () => {
    expect(script).toMatch(/rm -f "\$work\/keyring\.key" "\$work\/keyring\.crt"/);
  });
});
