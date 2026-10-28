// Project profile: what is being built, inferred from a plain description (or given as JSON).
// It decides which parts of the template a project gets, so a CLI tool never inherits design
// infrastructure and only projects that handle accounts, money or personal data get a security reviewer.
import fs from 'node:fs';
import path from 'node:path';
import { STARTER_ROOT, die } from './core.js';

export const KINDS = ['web-app', 'website', 'mobile-app', 'game', 'api', 'cli', 'library', 'data', 'other'];
export const SENSITIVE = ['auth', 'payments', 'pii', 'secrets'];
// One directory per stack under template/stacks; typescript renders the node directory with .ts files.
export const STACKS = [...fs.readdirSync(path.join(STARTER_ROOT, 'template', 'stacks')), 'typescript'];
export const stackDir = (stack) => (stack === 'typescript' ? 'node' : stack);

// Each rule: first matching pattern wins for single-valued fields; all matches count for lists.
// Patterns name the product, not incidental words: "users" or "server" alone says nothing about the project.
const KIND_RULES = [
  ['mobile-app', /\b(mobile app|ios|iphone|android|react native|expo|flutter|swiftui)\b/],
  ['website', /\b(landing page|website|portfolio|blog|marketing site|static site|docs site)\b/],
  ['game', /\b((an?|the|video|browser|mobile|2d|3d|multiplayer) game|game engine|roguelike|platformer|godot|unity|bevy|pygame|love2d|phaser|three\.?js)\b/],
  ['web-app', /\b(web ?app|dashboard|saas|frontend|single.page|next\.?js|nuxt|sveltekit|remix|react|vue|svelte|angular)\b/],
  ['cli', /\b(cli|command.line|terminal tool|console (app|tool))\b/],
  ['api', /\b(api|backend|rest ?api|restful|graphql|microservice|webhooks?|web server|http server|service|daemon|bot)\b/],
  ['data', /\b(data pipeline|etl|scrap\w*|analytics|notebook|machine learning|ml model|dataset|pandas)\b/],
  ['library', /\b(library|package|sdk|(npm|node) module|pypi|crate|gem|nuget)\b/],
  ['web-app', /\b(apps?|portal)\b/],
];
const VISUAL_KINDS = new Set(['web-app', 'website', 'mobile-app', 'game']);
// A named language wins over domain hints ("a scraper in Go" is Go, not Python); game engines bring their own toolchain.
const STACK_RULES = [
  ['generic', /\b(unity|godot|unreal)\b/],
  ['go', /\bgolang\b|\ba go\b(?!-)|^ go (cli|api|rest|service|microservice|library|server|tool|program|backend)\b|\b(in|with|using|written in) go\b/],
  ['rust', /\b(rust|cargo|crate|bevy|tauri)\b/],
  ['dotnet', /[\s(,/](c#|f#|\.net|asp\.net)(?=[\s),.;:/-])|\b(dotnet|blazor|maui)\b/],
  ['typescript', /\btypescript\b/],
  ['node', /\b(react|next\.?js|vue|svelte|sveltekit|nuxt|angular|expo|react native|electron|three\.?js|phaser)\b/],
  ['python', /\b(python|django|flask|fastapi|pytest|pypi|jupyter)\b/],
  ['node', /\b(node|javascript|express|deno|bun|npm)\b/],
  ['generic', /\b(java|kotlin|swift|swiftui|ruby|rails|php|laravel|elixir|dart|scala|zig|flutter)\b|[\s(,]c\+\+(?=[\s),.;:])|\b(in|written in) c\b(?![#+])|\ba c (library|program)\b/],
  ['python', /\b(pandas|numpy|pytorch|scrap\w*|machine learning)\b/],
];
const SENSITIVE_RULES = [
  ['auth', /\b(log ?ins?|sign ?ups?|sign ?ins?|auth|authentication|accounts|user accounts?|oauth|sso|passwords?|magic links?)\b/],
  ['payments', /\b(payments?|stripe|billing|checkout (page|flow)|subscriptions?|invoic\w+|paypal|credit cards?|charges? cards?)\b/],
  ['pii', /\b(personal (data|information|details)|pii|health (records|data)|medical|patients?|gdpr|hipaa|home addresses|phone numbers|customer data|date of birth)\b/],
  ['secrets', /\b(api keys?|secrets?|credentials|private keys?|(access|auth|api|bot) tokens?|(discord|telegram|slack) bot|wallets?)\b/],
];
const DB_RE = /\b(database|postgres\w*|mysql|sqlite|mongo\w*|supabase|prisma|drizzle|firebase|redis|sql|django|rails|laravel)\b/;
const VISUAL_HINT = /\b(ui|ux|design|brand\w*|visual|beautiful|landing|website|frontend|screens?|interface)\b/;

export function inferProfile(description, overrides = {}) {
  const text = ` ${String(description || '').toLowerCase()} `;
  const reasons = [];
  const pick = (rules, field) => {
    for (const [value, re] of rules) { const m = text.match(re); if (m) { reasons.push(`${field}: ${value} ("${m[0].trim()}")`); return value; } }
    return null;
  };
  const uncertain = [];
  const kind = overrides.kind || pick(KIND_RULES, 'kind') || (uncertain.push('kind'), 'other');
  const stack = overrides.stack || pick(STACK_RULES, 'stack') || (['web-app', 'website'].includes(kind) ? 'node' : (uncertain.push('stack'), 'generic'));
  const sensitive = overrides.sensitive || SENSITIVE_RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (!overrides.sensitive && sensitive.length) reasons.push(`sensitive: ${sensitive.join(', ')}`);
  const database = overrides.database ?? DB_RE.test(text);
  if (overrides.database === undefined && database) reasons.push(`database: yes ("${text.match(DB_RE)[0]}")`);
  let visual = overrides.visual;
  if (visual === undefined) {
    visual = VISUAL_KINDS.has(kind) || (kind === 'other' && VISUAL_HINT.test(text));
    reasons.push(`visual: ${visual ? 'yes' : 'no'} (${VISUAL_KINDS.has(kind) ? `${kind} has screens` : visual ? 'mentions design' : 'no screens described'})`);
  }
  return { ...validate({ kind, stack, visual: !!visual, sensitive, database: !!database, tasks: !!overrides.tasks, reasons }), uncertain };
}

export function validate(p) {
  for (const k of ['visual', 'database', 'tasks']) if (p[k] != null && typeof p[k] !== 'boolean') die(`profile.${k} must be true or false (got ${JSON.stringify(p[k])})`);
  for (const k of ['kind', 'stack', 'description']) if (p[k] != null && typeof p[k] !== 'string') die(`profile.${k} must be a string (got ${JSON.stringify(p[k])})`);
  if (p.sensitive != null && (!Array.isArray(p.sensitive) || p.sensitive.some((s) => typeof s !== 'string'))) die('profile.sensitive must be a list of strings, e.g. ["auth", "payments"]');
  if (!KINDS.includes(p.kind)) die(`profile.kind must be one of ${KINDS.join(', ')}`);
  if (!STACKS.includes(p.stack)) die(`profile.stack must be one of ${STACKS.join(', ')}`);
  const bad = (p.sensitive || []).filter((s) => !SENSITIVE.includes(s));
  if (bad.length) die(`profile.sensitive accepts ${SENSITIVE.join(', ')} (got ${bad.join(', ')})`);
  return { kind: p.kind, stack: p.stack, visual: !!p.visual, sensitive: [...new Set(p.sensitive || [])], database: !!p.database, tasks: !!p.tasks, reasons: p.reasons || [] };
}

// A profile written by a person or by the new-project skill.
export function readProfile(file) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`cannot read profile ${file}: ${e.message}`); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) die(`profile ${file} must be a JSON object`);
  return { description: p.description, ...validate({ ...p, reasons: ['from profile file'] }) };
}

// CLI flags override what the description implies.
export function flagOverrides(opts) {
  const o = {};
  if (opts.kind) o.kind = opts.kind;
  if (opts.stack) o.stack = opts.stack;
  if (opts.visual) o.visual = true;
  if (opts['no-visual']) o.visual = false;
  if (opts.sensitive !== undefined) o.sensitive = String(opts.sensitive).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
  if (opts.database) o.database = true;
  if (opts['no-database']) o.database = false;
  if (opts.tasks) o.tasks = true;
  return o;
}

export function describeProfile(p) {
  const parts = [`${p.kind} on ${p.stack}`, p.visual ? 'visual (Creative Director kit)' : 'no visual kit',
    p.sensitive.length ? `security reviewer for ${p.sensitive.join(', ')}` : 'no sensitive data', p.database ? 'database rules' : null,
    p.tasks ? 'task workflow (checkpoint hooks)' : null].filter(Boolean);
  return parts.join(' · ');
}
