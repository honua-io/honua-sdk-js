#!/usr/bin/env node
import path from "node:path";
import { packSampleContractArtifact } from "./lib/sample-contract-artifact.mjs";
const projectRoot = path.resolve(import.meta.dirname, "..");
const outputIndex = process.argv.indexOf("--output");
const outputDirectory = path.resolve(projectRoot, outputIndex < 0 ? ".artifacts/sample-contract" : process.argv[outputIndex + 1]);
console.log(JSON.stringify(await packSampleContractArtifact({ projectRoot, outputDirectory }), null, 2));
