// Fake `ddc` for offload tests: node fake-ddc.mjs <scenario.json> <status --json | run ...>
// status prints scenario.status; run swallows the stdin tar, records it to <scenario>.ran and exits scenario.exit.
import fs from 'node:fs';

const [scenarioFile, cmd, ...rest] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
if (cmd === 'status') {
  process.stdout.write(JSON.stringify(scenario.status));
} else if (cmd === 'run') {
  const tar = fs.readFileSync(0);
  fs.writeFileSync(`${scenarioFile}.ran`, JSON.stringify({ args: rest, bytes: tar.length, tar: tar.toString('latin1') }));
  process.exitCode = scenario.exit ?? 0;
} else process.exitCode = 64;
