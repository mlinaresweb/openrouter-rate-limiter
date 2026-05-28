export interface OpenRouterRateLimiterErrorInput {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

export class OpenRouterRateLimiterError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  public constructor(input: OpenRouterRateLimiterErrorInput) {
    super(input.message);

    this.name = 'OpenRouterRateLimiterError';
    this.code = input.code;

    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}