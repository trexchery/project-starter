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
import { cmdShot } from '../lib/design.js';

const HELP = `proj: start new projects with a tailored, agent-ready foundation

Create
  proj new <name> "what you are building"   understands the description and renders only what fits:
                                           stack, tests, CI, GitHub protections, AGENTS.md/CLAUDE.md,
                                           specialist agents, security/database rules, Creative Director kit
      [--kind ..] [--stack node|python|generic] [--visual|--no-visual] [--sensitive auth,payments,pii,secrets|none]
      [--database] [--tasks] [--profile file.json] [--dir <parent>] [--no-remote] [--no-protect] [--dry-run]
      --no-protect: create and push the repo, apply protections later with proj protect (after your own first push)
  proj adopt [--dry-run] [--upgrade] [same profile flags]   add missing pieces to an existing repo; never overwrites
  proj protect [--dry-run]                 squash-only, Dependabot, default-branch ruleset (plan-aware)
  proj shot <page.html|url> <out.png> [--width 1440] [--height 900] [--delay ms]   screenshot with local Chrome/Edge
                                           (page.html#state shows a state; --delay lets animations finish)

Optional utilities (nothing above requires them)
  tasks      proj task <slug> --goal .. | status | checkpoint | resume [--restore] | review | finish [--merge|--abandon]
  verify     proj check [--full|--heavy] [--remote] [--again] | proj check --heavy --ci | proj ready [--wait]
  CI cost    proj perf [--runs 20] [--json] | proj bench [--runs 3] | proj runner [status|start|use|clean]
  upkeep     proj doctor [--all] [--report] [--json] [--schedule weekly|off] | proj clean [--apply]
  compute    proj offload [\"<command>\"]   (a machine you already have, via ssh or your own command)
  hooks      proj hook <session-start|pre-compact|session-end>   (installed with --tasks)
  proj config | proj self-update | proj version`;

const BOOL = new Set(['dry-run', 'no-remote', 'upgrade', 'all', 'json', 'offline', 'push', 'restore', 'full', 'heavy',
  'remote', 'ci', 'wait', 'merge', 'abandon', 'report', 'deps', 'apply', 'quiet', 'clear-blockers', 'allow-overlap', 'verbose', 'help',
  'again', 'docker', 'host', 'hosted', 'visual', 'no-visual', 'database', 'no-database', 'tasks', 'no-protect']);

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

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parse(rest);
  if (!cmd || cmd === 'help' || opts.help) return out(HELP);
  switch (cmd) {
    case 'new': return cmdNew(pos[0], opts, pos.slice(1).join(' '));
    case 'shot': return cmdShot(pos[0], pos[1], opts);
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

main(process.argv.slice(2)).catch((e) => {
  if (!(e instanceof ProjError)) throw e;
  console.error(`proj: ${e.message}`);
  process.exitCode = e.code;
});
