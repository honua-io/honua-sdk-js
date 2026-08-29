import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module identified by `moduleUrl` is the process entrypoint.
 *
 * The obvious spelling of this check — `process.argv[1] === fileURLToPath(import.meta.url)`
 * — is correct only when the module file is invoked by its own path. npm installs a
 * package's `bin` entries as symlinks under `node_modules/.bin`, so a user (or an agent)
 * running the documented command gets `process.argv[1]` pointing at the shim, never at the
 * module file. The strings differ, the guard does not match, and the binary exits 0 having
 * done nothing at all (#1528).
 *
 * That is the worst available failure shape: no output, no diagnostic, no non-zero status —
 * nothing for a caller to react to. It is how the honua-release#123 terminal driver recorded
 * the pinned `honua-mcp-proxy` stage as blocked.
 *
 * Resolving both sides through `realpath` makes the shim and the module compare equal. The
 * guard is kept rather than dropped because these modules are also imported by tests, which
 * must not start a server as a side effect of importing.
 */
export function isMainEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  if (invoked === modulePath) {
    return true;
  }

  // realpathSync throws for a path that does not exist, which is not an error here:
  // it just means this module is not what was invoked.
  try {
    return realpathSync(invoked) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
