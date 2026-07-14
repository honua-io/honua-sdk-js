import { sink } from "./external.js";

function holder(): unknown {
  function sink(configuration: NodeJS.ProcessEnv): string | undefined {
    const { HONUA_DECOY_URL } = configuration;
    return HONUA_DECOY_URL;
  }

  return sink;
}

void holder;
sink(process.env);
