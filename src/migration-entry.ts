const MIGRATION_COMPATIBILITY_MESSAGE =
  "@honua/sdk-js/migration has moved to @honua/honua-migrate. " +
  "Use the honua-js-migrate command for JavaScript migrations. " +
  "This compatibility subpath will remain for at least two consecutive honua-migrate minor releases and 90 days, " +
  "and will not be removed before honua-migrate 1.2.";

type WarningEmitter = {
  emitWarning(message: string, options: { code: string; type: string }): void;
};

const runtimeProcess = (globalThis as { process?: WarningEmitter }).process;
runtimeProcess?.emitWarning(MIGRATION_COMPATIBILITY_MESSAGE, {
  code: "HONUA_MIGRATION_MOVED",
  type: "DeprecationWarning",
});

export * from "@honua/honua-migrate";
