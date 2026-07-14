import {
  canonicalCommand,
  classifySampleCommand,
  isPlaywrightCommand,
  parseSampleCommand,
} from "./sample-command.mjs";

function fail(message) {
  throw new Error(message);
}

function oneCommand(commands, label) {
  if (commands.length !== 1) fail(`${label} requires exactly one bound command, found ${commands.length}`);
  return commands[0];
}

function commandsForAction(sample, action) {
  return sample.commandPlan.validation.commands
    .map(parseSampleCommand)
    .filter((argv) => classifySampleCommand(argv) === action);
}

function evidencePlaywrightCommand(argv) {
  if (argv[0] === "npm") return [...argv, "--", "--reporter=json"];
  return [...argv, "--reporter=json"];
}

export function expectedGateCommand(sample, gate) {
  if (gate === "packed-build") return oneCommand(commandsForAction(sample, "build"), `${sample.id} packed build gate`);
  if (gate === "fixture") {
    return [...oneCommand(sample.commandPlan.fixtureEvidence.commands.map(parseSampleCommand), `${sample.id} fixture gate`), "--", "--evidence-once"];
  }
  if (gate === "live") return oneCommand(sample.commandPlan.liveEvidence.commands.map(parseSampleCommand), `${sample.id} live gate`);
  const validation = sample.commandPlan.validation.commands.map(parseSampleCommand);
  if (gate === "performance") {
    return oneCommand(validation.filter((argv) => canonicalCommand(argv).match(/(?:bench|performance)/)), `${sample.id} performance gate`);
  }
  return evidencePlaywrightCommand(
    oneCommand(validation.filter(isPlaywrightCommand), `${sample.id} ${gate} gate`),
  );
}
