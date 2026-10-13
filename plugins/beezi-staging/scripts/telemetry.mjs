import { setTelemetry } from '../lib/commands/telemetry.mjs';

process.stdout.write(`${setTelemetry(process.argv[2])}\n`);
