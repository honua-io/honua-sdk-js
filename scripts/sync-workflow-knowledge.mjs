import fs from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3 || !["--check", "--write"].includes(process.argv[2]))
  throw new Error("Use --check or --write.");
const source = new URL("../src/studio-agent/workflow-knowledge.ts", import.meta.url);
const target = new URL("../mcp/src/agent/workflow-knowledge.ts", import.meta.url);
const generated =
  "// Generated from src/studio-agent/workflow-knowledge.ts.\n" +
  "// Update the canonical source, then run node scripts/sync-workflow-knowledge.mjs --write.\n" +
  fs.readFileSync(source, "utf8");
if (process.argv[2] === "--write") fs.writeFileSync(target, generated);
else if (fs.readFileSync(target, "utf8") !== generated)
  throw new Error("Regenerate the MCP knowledge module from the canonical SDK source.");
console.log(`workflowKnowledge=${fileURLToPath(target)}`);
