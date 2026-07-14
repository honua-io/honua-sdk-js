import { readEnvironment } from "./external.js";

function holder(): unknown {
  function readEnvironment(key: string): string | undefined {
    return process.env[key];
  }

  return readEnvironment;
}

void holder;
export const importedReaderUrl = readEnvironment("HONUA_IMPORTED_READER_URL");
