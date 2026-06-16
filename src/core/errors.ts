/**
 * Custom error types for the RDT v2 task runner.
 */

export class StateTransitionError extends Error {
  public from: string;
  public to: string;
  public allowedTransitions: string[];

  constructor(from: string, to: string, allowedTransitions: string[]) {
    super(
      `Invalid state transition: ${from} -> ${to}. ` +
        `Allowed transitions from ${from}: [${allowedTransitions.join(', ')}]`,
    );
    this.name = 'StateTransitionError';
    this.from = from;
    this.to = to;
    this.allowedTransitions = allowedTransitions;
  }
}
