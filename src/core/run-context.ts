/* ==========================================================================
   gherkin-ai-cli - Run context (global flags for the current invocation)

   Populated once by the CLI entry point from global flags. The legacy GHK_*
   environment variables are still honored so CI scripts and embedders that
   set them keep working.
   ========================================================================== */

export interface RunContext {
  nonInteractive: boolean;
  json: boolean;
  dryRun: boolean;
  stdout: boolean;
  verbose: boolean;
  quiet: boolean;
  command?: string;
  startedAt: number;
}

const truthy = (value: string | undefined) => value === 'true' || value === '1';

let current: Partial<RunContext> = {};

export function setRunContext(partial: Partial<RunContext>): void {
  current = { ...current, ...partial };
}

export function resetRunContext(): void {
  current = {};
}

export function getRunContext(): RunContext {
  const env = process.env;
  return {
    nonInteractive: Boolean(current.nonInteractive) || truthy(env.GHK_NON_INTERACTIVE) || truthy(env.CI),
    json: Boolean(current.json),
    dryRun: Boolean(current.dryRun) || truthy(env.GHK_DRY_RUN),
    stdout: Boolean(current.stdout) || truthy(env.GHK_STDOUT),
    verbose: Boolean(current.verbose),
    quiet: Boolean(current.quiet),
    command: current.command,
    startedAt: current.startedAt ?? Date.now()
  };
}

/** True when prompts must not be shown: --yes/--non-interactive, CI=true or GHK_NON_INTERACTIVE=true. */
export function isNonInteractive(options?: { yes?: boolean; nonInteractive?: boolean }): boolean {
  return Boolean(options?.yes || options?.nonInteractive) || getRunContext().nonInteractive;
}

export function isCI(): boolean {
  return truthy(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || process.env.TF_BUILD || process.env.JENKINS_URL);
}
