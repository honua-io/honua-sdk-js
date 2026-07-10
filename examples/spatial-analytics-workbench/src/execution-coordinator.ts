export interface AnalysisExecutionTicket<TContext> {
  readonly context: TContext;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface AnalysisExecutionCoordinator<TContext> {
  readonly generation: number;
  begin(context: TContext): AnalysisExecutionTicket<TContext>;
  invalidate(): void;
  isCurrent(ticket: AnalysisExecutionTicket<TContext>, context: TContext): boolean;
  finish(ticket: AnalysisExecutionTicket<TContext>): boolean;
}

export function createAnalysisExecutionCoordinator<TContext>(): AnalysisExecutionCoordinator<TContext> {
  let generation = 0;
  let active: (AnalysisExecutionTicket<TContext> & { readonly controller: AbortController }) | undefined;

  return {
    get generation() {
      return generation;
    },
    begin(context) {
      active?.controller.abort();
      generation += 1;
      const controller = new AbortController();
      active = { context, generation, signal: controller.signal, controller };
      return active;
    },
    invalidate() {
      generation += 1;
      active?.controller.abort();
      active = undefined;
    },
    isCurrent(ticket, context) {
      return active === ticket && ticket.generation === generation && ticket.context === context;
    },
    finish(ticket) {
      if (active !== ticket) return false;
      active = undefined;
      return true;
    },
  };
}
