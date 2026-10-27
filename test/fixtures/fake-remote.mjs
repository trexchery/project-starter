// Fake remote transport for offload tests: node fake-remote.mjs <scenario.json> <script>
// The `nproc ...` probe answers the availability probe; any other script swallows the stdin tar, records it to
// <scenario>.ran and exits with scenario.exit.
import fs from 'node:fs';

const [scenarioFile, script] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
if (script.startsWith('nproc')) {
  if (scenario.probeErr) process.stderr.write(scenario.probeErr);
  if (scenario.probeExit) process.exitCode = scenario.probeExit;
  else process.stdout.write(`${scenario.cpus ?? 64}\n`);
} else {
  const tar = fs.readFileSync(0);
  fs.writeFileSync(`${scenarioFile}.ran`, JSON.stringify({ script, bytes: tar.length, tar: tar.toString('latin1') }));
  process.exitCode = scenario.exit ?? 0;
}
