/**
 * Compile-time contract evidence for the atomic query-capable protocol seam.
 *
 * This file is included by the repository typecheck. The negative assignments
 * prove that neither half of the compile/execute pair can satisfy the public
 * query-capable module type by itself.
 */
import type { ProtocolModule, ProtocolModuleQueryBinding, QueryCapableProtocolModule } from "../src/contract/index.js";

interface TestBinding extends ProtocolModuleQueryBinding {
  readonly source: { readonly id: string };
  readonly compileQuery: { readonly limit?: number };
  readonly compiled: { readonly compiler: "test-v1" };
  readonly executeQuery: { readonly includeGeometry?: boolean };
}

type TestBaseModule = ProtocolModule<"test-query", { readonly id: string }>;
type TestQueryModule = QueryCapableProtocolModule<"test-query", { readonly id: string }, TestBinding>;

export function queryCapableModuleTypechecks(
  compileOnly: TestBaseModule & Pick<TestQueryModule, "compile">,
  executeOnly: TestBaseModule & Pick<TestQueryModule, "execute">,
): void {
  // @ts-expect-error A query-capable module requires execute whenever compile is present.
  const missingExecute: TestQueryModule = compileOnly;
  // @ts-expect-error A query-capable module requires compile whenever execute is present.
  const missingCompile: TestQueryModule = executeOnly;

  void missingExecute;
  void missingCompile;
}
