/** Representative leaf-error import with a credential/path-safe JSON projection. */
import { HonuaRealtimeResumeError } from "@honua/sdk-js/realtime";

export function leafErrorEvidence() {
  return JSON.stringify(
    new HonuaRealtimeResumeError(
      "delivery-failed",
      "message secret at /home/customer/private/checkpoint.json",
      {
        cause: {
          token: "leaf-token-secret",
          path: "/home/customer/private/checkpoint.json",
        },
      },
    ),
  );
}
