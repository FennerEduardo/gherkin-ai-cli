/* ==========================================================================
   gherkin-ai-cli - 'web' Command Handler (Local UI Server)
   ========================================================================== */

import { startWebServer } from '../ui/server';
import inquirer from 'inquirer';

export async function handleWebCommand(options: any): Promise<void> {
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
    console.error('❌ Invalid port number.');
    process.exit(1);
  }

  startWebServer(portNum);
}
