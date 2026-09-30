#!/usr/bin/env node
import { run } from '../src/index.js';

run(process.argv.slice(2)).catch((error) => {
  const { logger } = { logger: null };
  process.stderr.write(`\n\x1b[31m✖ ${error.message}\x1b[0m\n`);
  if (process.env.EMEEEK_DEBUG) process.stderr.write(`${error.stack}\n`);
  else process.stderr.write('\x1b[2m加 EMEEEK_DEBUG=1 可查看完整堆栈\x1b[0m\n');
  process.exit(1);
});
