// Single source of truth for the CLI version (read from package.json at runtime).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { name: string; version: string; homepage?: string };

export const CLI_NAME: string = pkg.name;
export const CLI_VERSION: string = pkg.version;
export const CLI_HOMEPAGE: string | undefined = pkg.homepage;
