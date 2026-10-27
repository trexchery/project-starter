// Project profile: what is being built, inferred from a plain description (or given as JSON).
// It decides which parts of the template a project gets, so a CLI tool never inherits design
// infrastructure and only projects that handle accounts, money or personal data get a security reviewer.
import fs from 'node:fs';
import { die } from './core.js';

export const KINDS = ['web-app', 'website', 'mobile-app', 'game', 'api', 'cli', 'library', 'data', 'other'];
export const SENSITIVE = ['auth', 'payments', 'pii', 'secrets'];

// Each rule: first matching pattern wins for single-valued fields; all matches count for lists.
const KIND_RULES = [
  ['mobile-app', /\b(mobile app|ios|android|react native|expo|flutter)\b/],
  ['game', /\b(game|godot|unity|phaser|three\.?js)\b/],
  ['website', /\b(landing page|website|portfolio|blog|marketing site|static site|docs site)\b/],
  ['web-app', /\b(web ?app|dashboard|saas|frontend|single.page|next\.?js|nuxt|sveltekit|remix|react|vue|svelte|angular)\b/],
  ['cli', /\b(cli|command.line|terminal tool)\b/],
  ['api', /\b(api|backend|rest|graphql|microservice|webhook|server)\b/],
  ['data', /\b(data pipeline|etl|scrap\w*|analytics|notebook|machine learning|ml model|dataset|pandas)\b/],
  ['library', /\b(library|package|sdk|npm module|pypi)\b/],
];
const VISUAL_KINDS = new Set(['web-app', 'website', 'mobile-app', 'game']);
const STACK_RULES = [
  ['python', /\b(python|django|flask|fastapi|pandas|numpy|pytorch|jupyter|pytest|pypi|scrap\w*|machine learning)\b/],
  ['node', /\b(node|javascript|typescript|react|next\.?js|vue|svelte|nuxt|express|deno|bun|npm|electron|expo|react native|three\.?js|phaser)\b/],
  ['generic', /\b(go|golang|rust|java|kotlin|swift|c\+\+|c#|\.net|ruby|php|godot|unity|flutter)\b/],
];
const SENSITIVE_RULES = [
  ['auth', /\b(log ?in|sign ?up|auth\w*|accounts?|users?|sessions?|oauth|passwords?)\b/],
  ['payments', /\b(payments?|stripe|billing|checkout|subscriptions?|invoices?|paypal|money|wallet)\b/],
  ['pii', /\b(personal data|pii|health|medical|patients?|gdpr|hipaa|addresses|phone numbers|customers?)\b/],
  ['secrets', /\b(api keys?|secrets?|credentials|private keys?|tokens?)\b/],
];
const DB_RE = /\b(database|postgres\w*|mysql|sqlite|mongo\w*|supabase|prisma|drizzle|firebase|redis|sql)\b/;
const VISUAL_HINT = /\b(ui|ux|design|brand\w*|visual|beautiful|landing|website|frontend|screens?|interface)\b/;

export function inferProfile(description, overrides = {}) {
  const text = ` ${String(description || '').toLowerCase()} `;
  const reasons = [];
  const pick = (rules, field) => {
    for (const [value, re] of rules) { const m = text.match(re); if (m) { reasons.push(`${field}: ${value} ("${m[0].trim()}")`); return value; } }
    return null;
  };
  const kind = overrides.kind || pick(KIND_RULES, 'kind') || 'other';
  const stack = overrides.stack || pick(STACK_RULES, 'stack') || (['web-app', 'website'].includes(kind) ? 'node' : 'generic');
  const sensitive = overrides.sensitive || SENSITIVE_RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (!overrides.sensitive && sensitive.length) reasons.push(`sensitive: ${sensitive.join(', ')}`);
  const database = overrides.database ?? DB_RE.test(text);
  if (overrides.database === undefined && database) reasons.push(`database: yes ("${text.match(DB_RE)[0]}")`);
  let visual = overrides.visual;
  if (visual === undefined) {
    visual = VISUAL_KINDS.has(kind) || (kind === 'other' && VISUAL_HINT.test(text));
    reasons.push(`visual: ${visual ? 'yes' : 'no'} (${VISUAL_KINDS.has(kind) ? `${kind} has screens` : visual ? 'mentions design' : 'no screens described'})`);
  }
  return validate({ kind, stack, visual: !!visual, sensitive, database: !!database, tasks: !!overrides.tasks, reasons });
}

export function validate(p) {
  if (!KINDS.includes(p.kind)) die(`profile.kind must be one of ${KINDS.join(', ')}`);
  if (!['node', 'python', 'generic'].includes(p.stack)) die('profile.stack must be node, python or generic');
  const bad = (p.sensitive || []).filter((s) => !SENSITIVE.includes(s));
  if (bad.length) die(`profile.sensitive accepts ${SENSITIVE.join(', ')} (got ${bad.join(', ')})`);
  return { kind: p.kind, stack: p.stack, visual: !!p.visual, sensitive: [...new Set(p.sensitive || [])], database: !!p.database, tasks: !!p.tasks, reasons: p.reasons || [] };
}

// A profile written by a person or by the new-project skill.
export function readProfile(file) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`cannot read profile ${file}: ${e.message}`); }
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
