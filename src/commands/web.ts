/* ==========================================================================
   gherkin-ai-cli - 'web' Command Handler (Local UI Server)
   ========================================================================== */

import { PolicyError, UsageError } from '../core/errors';
import { startWebServer } from '../ui/server';
import inquirer from 'inquirer';

export async function handleWebCommand(options: any): Promise<void> {
  if (process.env.CI === 'true') {
    throw new PolicyError('Web Studio is disabled in CI environments for security reasons.');
  }

  let port = options.port;
  
  if (!port) {
    const { selectedPort } = await inquirer.prompt([{
      type: 'input',
      name: 'selectedPort',
      message: 'Enter the port to run the Web UI on (default: 3000):',
      default: '3000'
    }]);
    port = selectedPort;
  }

  const portNum = parseInt(port, 10);
  
  if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
    throw new UsageError(`Invalid port number: ${port}`);
  }

  startWebServer(portNum);
}
