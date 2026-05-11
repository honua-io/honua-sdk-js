import { CAPABILITIES, type Capability, PROTOCOLS, type Protocol } from "@honua/sdk-js";
import { explainHonuaCapabilityGap } from "@honua/sdk-js/agent-tools";
import { z } from "zod";
import { jsonText } from "../helpers.js";

const capabilitySchema = z.string().refine((value): value is Capability => CAPABILITIES.includes(value as Capability), {
  message: "Unknown Honua capability",
});
const protocolSchema = z
  .string()
  .refine((value): value is Protocol => PROTOCOLS.includes(value as Protocol), {
    message: "Unknown Honua protocol",
  })
  .optional();

export const schema = z.object({
  capability: capabilitySchema.describe("Honua capability to check"),
  protocol: protocolSchema.describe("Optional Honua protocol identifier"),
  sourceId: z.string().optional().describe("Optional source id for the explanation"),
  declaredCapabilities: z.array(capabilitySchema).optional().describe("Optional source-declared capabilities"),
});

export type Input = z.infer<typeof schema>;

export async function execute(_client: unknown, input: Input) {
  return jsonText({
    explanation: explainHonuaCapabilityGap(input),
  });
}
