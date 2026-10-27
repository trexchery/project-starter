#!/usr/bin/env node
// proj: bootstrap repos, run tracked agent worktrees, verify at exact SHAs, clean up safely.
import fs from 'node:fs';
import path from 'node:path';
import { ProjError, STARTER_ROOT, HOME, git, sh, out, readJson, loadConfig, repoContext } from '../lib/core.js';
import { cmdNew, cmdAdopt, protect } from '../lib/bootstrap.js';
import { cmdTask, cmdStatus, cmdFinish, cmdCheckpoint, cmdResume, cmdReview, cmdHook } from '../lib/tasks.js';
import { cmdCheck, cmdReady, cmdOffload } from '../lib/checks.js';
import { cmdDoctor, cmdClean } from '../lib/maint.js';
import { cmdPerf, cmdBench } from '../lib/perf.js';
import { cmdRunner } from '../lib/runner.js';

const HELP = `proj: project starter and agent task manager

  proj new <name> [--stack node|python|generic] [--description ".."] [--dir <parent>] [--no-remote] [--dry-run]
  proj adopt [--dry-run] [--upgrade]       add missing starter files to this repo; never overwrites
  proj protect [--dry-run]                 squash-only, Dependabot, default-branch ruleset (plan-aware)

  proj task <slug> --goal ".." [--issue N] [--files "src/x/**"]   new tracked worktree (cap: maxAgents)
  proj status [--all] [--json] [--offline] implemented / tested / reviewed / CI-verified / released per task
  proj checkpoint [--next ".."] [--decision ".."] [--blocker ".."] [--clear-blockers] [--push]
  proj resume [<slug>] [--restore]         print the handoff; --restore recreates a lost worktree
  proj review [--verdict pass|fail] [--by who] [--note ..]   record a review at the exact SHA
  proj check [--full|--heavy] [--remote] [--again]   change-aware tier by default (fails closed to full);
                                           a tier that already passed at this clean SHA is not rerun
  proj check --heavy --ci                  dispatch the Heavy workflow for this pushed SHA (once per SHA)
  proj ready [--wait]                      full (+heavy) passed at SHA -> push, PR ready -> CI once on that SHA
  proj perf [--runs 20] [--json]           per-file, job, workflow durations, billed minutes, waste, timeouts
  proj bench [--runs 3] [--setup 45]       measure variants/shards (wall + billed minutes) before adopting
  proj runner [status|start|use|clean] [--docker|--host|--ddc] [--dry-run]   ephemeral self-hosted CI runners
  proj finish [<slug>] [--merge | --abandon]
  proj offload ["<command>"]               show ddc availability, or run a command there
  proj doctor [--all] [--report] [--deps] [--offline] [--json] [--schedule weekly|off]
  proj clean [--apply]                     dry run unless --apply; never forces, never touches dirty work
  proj hook <session-start|pre-compact|session-end>   (called by Claude Code / Codex hooks)
  proj config | proj self-update | proj version`;

const BOOL = new Set(['dry-run', 'no-remote', 'upgrade', 'all', 'json', 'offline', 'push', 'restore', 'full', 'heavy',
  'remote', 'ci', 'wait', 'merge', 'abandon', 'report', 'deps', 'apply', 'quiet', 'clear-blockers', 'allow-overlap', 'verbose', 'help',
  'again', 'docker', 'host', 'ddc', 'hosted']);

export function parse(argv) {
  const opts = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) opts[k] = v;
    else if (BOOL.has(k)) opts[k] = true;
    else if (i + 1 < argv.length) opts[k] = argv[++i];
    else throw new ProjError(`--${k} needs a value`);
  }
  return { pos, opts };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parse(rest);
  if (!cmd || cmd === 'help' || opts.help) return out(HELP);
  switch (cmd) {
    case 'new': return cmdNew(pos[0], opts);
    case 'adopt': return cmdAdopt(opts);
    case 'protect': return protect(repoContext(), opts);
    case 'task': return cmdTask(pos[0], opts);
    case 'status': return cmdStatus(opts);
    case 'checkpoint': return cmdCheckpoint({ ...opts, task: pos[0] });
    case 'resume': return cmdResume(pos[0], opts);
    case 'review': return cmdReview(opts);
    case 'check': return cmdCheck(opts);
    case 'ready': return cmdReady(opts);
    case 'finish': return cmdFinish(pos[0], opts);
    case 'offload': return cmdOffload(pos.join(' '), opts);
    case 'doctor': return cmdDoctor(opts);
    case 'clean': return cmdClean(opts);
    case 'perf': return cmdPerf(opts);
    case 'bench': return cmdBench(opts);
    case 'runner': return cmdRunner(pos[0], opts);
    case 'hook': return cmdHook(pos[0]);
    case 'config': return out(JSON.stringify({ home: HOME, starter: STARTER_ROOT, ...loadConfig(git(['rev-parse', '--show-toplevel']).out || undefined) }, null, 2));
    case 'self-update': {
      // A git clone pulls; an `npm install -g github:...` copy reinstalls from the same repository.
      if (fs.existsSync(path.join(STARTER_ROOT, '.git'))) {
        const r = git(['pull', '--ff-only', '--quiet'], { cwd: STARTER_ROOT });
        return out(r.code === 0 ? `project-starter at ${git(['rev-parse', '--short', 'HEAD'], { cwd: STARTER_ROOT }).out}` : `update failed: ${r.err}`);
      }
      const { repository } = readJson(path.join(STARTER_ROOT, 'package.json'), {});
      process.exitCode = sh(`npm install -g ${repository}`);
      return;
    }
    case 'version': {
      const { version } = readJson(path.join(STARTER_ROOT, 'package.json'), {});
      const rev = git(['describe', '--always', '--dirty'], { cwd: STARTER_ROOT });
      return out(rev.code === 0 ? `${version} (${rev.out})` : version);
    }
    default: throw new ProjError(`unknown command "${cmd}" (proj help)`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof ProjError)) throw e;
  console.error(`proj: ${e.message}`);
  process.exitCode = e.code;
}
