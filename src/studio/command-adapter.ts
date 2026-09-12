/**
 * Thin Studio transport adapter for the shared application-command layer.
 *
 * This module owns no workflow, validation, authorization, or receipt logic.
 * It fixes the transport discriminator to `studio` and delegates to the same
 * command objects and runtime used by direct SDK, CLI, and MCP callers.
 */

import {
  type HonuaCommand,
  type HonuaCommandIdentity,
  type HonuaCommandInvocation,
  type HonuaCommandReceipt,
  type HonuaCommandRuntime,
  type StudioDraftSaveVersionInput,
  createHonuaCommandRuntime,
  studioDraftSaveVersionCommand,
} from "../control-plane/commands/index.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaStudioLifecycleClient } from "./lifecycle-client.js";
import type { StudioContentVersion } from "./lifecycle-types.js";

/** Invocation fields a Studio host may supply; transport selection is adapter-owned. */
export type HonuaStudioCommandInvocation = Omit<HonuaCommandInvocation, "transport">;

/** Constructor options for {@link HonuaStudioCommandAdapter}. */
export interface HonuaStudioCommandAdapterOptions {
  readonly client: HonuaClient;
  readonly lifecycle?: HonuaStudioLifecycleClient;
  readonly identity?: HonuaCommandIdentity;
}

/** Construct a Studio adapter over the shared command runtime. */
export function createHonuaStudioCommandAdapter(options: HonuaStudioCommandAdapterOptions): HonuaStudioCommandAdapter {
  return new HonuaStudioCommandAdapter(options);
}

/**
 * Studio-facing command dispatcher. UI code adapts form state into command
 * input and renders the returned receipt; all application behavior remains in
 * the shared command catalog.
 */
export class HonuaStudioCommandAdapter {
  readonly #runtime: HonuaCommandRuntime;

  public constructor(options: HonuaStudioCommandAdapterOptions) {
    this.#runtime = createHonuaCommandRuntime({
      client: options.client,
      studio: options.lifecycle ?? new HonuaStudioLifecycleClient({ client: options.client }),
      identity: options.identity,
    });
  }

  /** Dispatch any shared command with Studio as the immutable transport. */
  public execute<TInput, TOutput>(
    command: HonuaCommand<TInput, TOutput>,
    input: TInput,
    invocation: HonuaStudioCommandInvocation = {},
  ): Promise<HonuaCommandReceipt<TOutput>> {
    return this.#runtime.execute(command, input, { ...invocation, transport: "studio" });
  }

  /** Save a draft through the shared `studio.draft.saveVersion` command. */
  public saveDraftVersion(
    input: StudioDraftSaveVersionInput,
    invocation: HonuaStudioCommandInvocation = {},
  ): Promise<HonuaCommandReceipt<StudioContentVersion>> {
    return this.execute(studioDraftSaveVersionCommand, input, invocation);
  }
}
