#!/usr/bin/env node

import { createProgram } from './commands.js';
import { runWizard } from './wizard.js';

async function main() {
  const program = createProgram();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    await runWizard();
    return;
  }

  program.parse(process.argv);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
