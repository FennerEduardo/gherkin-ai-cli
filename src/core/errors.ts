/* ==========================================================================
   gherkin-ai-cli - Error taxonomy & exit codes

   Exit codes are part of the public CLI contract (see docs/ENTERPRISE.md).
   Do not renumber existing codes.
   ========================================================================== */

export const ExitCode = {
  OK: 0,
  /** Unexpected / unclassified failure. */
  GENERIC: 1,
  /** Invalid flags, arguments or command usage. */
  USAGE: 2,
  /** Configuration file missing a required value or failing schema validation. */
  CONFIG: 3,
  /** A quality gate failed (lint, validate, converge --strict). */
  GATE_FAILED: 4,
  /** An organization or governance policy denied the operation. */
  POLICY_DENIED: 5,
  /** LLM provider or network failure (auth, timeout, rate limit, TLS, proxy). */
  PROVIDER: 6,
  /** Specification drift detected (verify / converge). */
  DRIFT: 7
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class GhkError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.GENERIC, options: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message);
    this.name = 'GhkError';
    this.exitCode = exitCode;
    this.hint = options.hint;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ConfigError extends GhkError {
  constructor(message: string, options: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, ExitCode.CONFIG, options);
    this.name = 'ConfigError';
  }
}

export class PolicyError extends GhkError {
  constructor(message: string, options: { hint?: string; details?: unknown } = {}) {
    super(message, ExitCode.POLICY_DENIED, options);
    this.name = 'PolicyError';
  }
}

export class ProviderError extends GhkError {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean; hint?: string; cause?: unknown } = {}) {
    super(message, ExitCode.PROVIDER, options);
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export class UsageError extends GhkError {
  constructor(message: string, options: { hint?: string } = {}) {
    super(message, ExitCode.USAGE, options);
    this.name = 'UsageError';
  }
}

/** Normalizes anything thrown into a GhkError so the top-level handler has one shape to render. */
export function toGhkError(err: unknown): GhkError {
  if (err instanceof GhkError) return err;
  if (err instanceof Error) return new GhkError(err.message, ExitCode.GENERIC, { cause: err });
  return new GhkError(String(err));
}
