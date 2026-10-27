#!/usr/bin/env node
// proj: bootstrap repos, run tracked agent worktrees, verify at exact SHAs, clean up safely.
import { ProjError, STARTER_ROOT, HOME, git, out, loadConfig, repoContext } from '../lib/core.js';
import { cmdNew, cmdAdopt, protect } from '../lib/bootstrap.js';
import { cmdTask, cmdStatus, cmdFinish, cmdCheckpoint, cmdResume, cmdReview, cmdHook } from '../lib/tasks.js';
import { cmdCheck, cmdReady, cmdOffload } from '../lib/checks.js';
import { cmdDoctor, cmdClean } from '../lib/maint.js';

const HELP = `proj: project starter and agent task manager

  proj new <name> [--stack node|python|generic] [--description ".."] [--dir <parent>] [--no-remote] [--dry-run]
  proj adopt [--dry-run] [--upgrade]       add missing starter files to this repo; never overwrites
  proj protect [--yes]                     squash-only, Dependabot, default-branch ruleset (plan-aware)

  proj task <slug> --goal ".." [--issue N] [--files "src/x/**"]   new tracked worktree (cap: maxAgents)
  proj status [--all] [--json] [--offline] implemented / tested / reviewed / CI-verified / released per task
  proj checkpoint [--next ".."] [--decision ".."] [--blocker ".."] [--clear-blockers] [--push]
  proj resume [<slug>] [--restore]         print the handoff; --restore recreates a lost worktree
  proj review [--verdict pass|fail] [--by who] [--note ..]   record a review at the exact SHA
  proj check [--full|--heavy] [--remote]   affected tests by default; --remote uses a running ddc box
  proj check --heavy --ci --yes            dispatch the Heavy workflow for this SHA (Actions minutes)
  proj ready [--yes] [--wait]              full suite passed at SHA -> push, PR ready -> CI on that SHA
  proj finish [<slug>] [--merge --yes | --abandon --yes]
  proj offload ["<command>"]               show ddc availability, or run a command there
  proj doctor [--all] [--report] [--deps] [--offline] [--schedule weekly|off]
  proj clean [--apply]                     dry run unless --apply; never forces, never touches dirty work
  proj hook <session-start|pre-compact|session-end>   (called by Claude Code / Codex hooks)
  proj config | proj self-update | proj version

Outward actions (merge, mark ready, dispatch CI, change GitHub settings) need --yes: pass it only
with the owner's approval for this action.`;

const BOOL = new Set(['dry-run', 'no-remote', 'yes', 'upgrade', 'all', 'json', 'offline', 'push', 'restore', 'full', 'heavy',
  'remote', 'ci', 'wait', 'merge', 'abandon', 'report', 'deps', 'apply', 'quiet', 'clear-blockers', 'allow-overlap', 'verbose', 'help']);

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
    case 'hook': return cmdHook(pos[0]);
    case 'config': return out(JSON.stringify({ home: HOME, starter: STARTER_ROOT, ...loadConfig(git(['rev-parse', '--show-toplevel']).out || undefined) }, null, 2));
    case 'self-update': {
      const r = git(['pull', '--ff-only', '--quiet'], { cwd: STARTER_ROOT });
      return out(r.code === 0 ? `project-starter at ${git(['rev-parse', '--short', 'HEAD'], { cwd: STARTER_ROOT }).out}` : `update failed: ${r.err}`);
    }
    case 'version': return out(git(['describe', '--always', '--dirty'], { cwd: STARTER_ROOT }).out);
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
