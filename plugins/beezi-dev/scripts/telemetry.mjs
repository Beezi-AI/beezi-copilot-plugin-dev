import { setTelemetry } from '../lib/commands/telemetry.mjs';

const message = setTelemetry(process.argv[2]);
if (message != null) process.stdout.write(`${message}\n`);
