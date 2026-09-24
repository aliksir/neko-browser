#!/usr/bin/env node
import { NekoBrowserServer } from './server.js';

process.stderr.write('neko-browser v0.3.0\n');

const server = new NekoBrowserServer();

async function main(): Promise<void> {
  await server.start();
}

async function cleanup(): Promise<void> {
  process.stderr.write('Shutting down neko-browser...\n');
  await server.stop();
  process.exit(0);
}

process.on('SIGINT', () => {
  cleanup().catch((err: unknown) => {
    process.stderr.write(`Cleanup error: ${String(err)}\n`);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  cleanup().catch((err: unknown) => {
    process.stderr.write(`Cleanup error: ${String(err)}\n`);
    process.exit(1);
  });
});

main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`);
  process.exit(1);
});
