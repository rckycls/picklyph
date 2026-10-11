#!/usr/bin/env node
'use strict';
// Offline release check (T50b): run before an EAS build, `supabase db push` or a function deploy.
// It prints setting names and project refs only, never values. See docs/release.md#release-check.

const fs = require('node:fs');
const path = require('node:path');
const release = require('./release/environment.cjs');

const root = path.resolve(path.dirname(module.filename), '..');
const USAGE = `Usage: npm run release:check -- --variant <development|preview|production> <checks>
Checks (at least one):
  --env-file <path>   app values from \`eas env:pull --environment <environment> --path <path>\`
  --bundle <dir>      an iOS export (dist/ios from \`npm run bundle:ios\`) or an unzipped EAS .ipa
  --secrets <file>    \`supabase secrets list --project-ref <ref> -o json\` for the variant's backend
  --compare <file>    the same list for the other backend (needs --secrets)
  --linked            the Supabase CLI's linked project must be the variant's backend`;
// Exported or built app files worth scanning (main.jsbundle inside an unzipped .ipa); images and fonts are skipped.
const BUNDLE_FILES = /\.(hbc|jsbundle|js|json|map|txt)$/i;

class UsageError extends Error {}

// Windows PowerShell 5.1 redirects (`>`) write UTF-16 with a byte-order mark; others write UTF-8.
function readText(file) {
  const bytes = fs.readFileSync(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function parseArgs(argv) {
  const options = { linked: false };
  const takesValue = { '--variant': 'variant', '--env-file': 'envFile', '--bundle': 'bundle', '--secrets': 'secrets', '--compare': 'compare', '--environments': 'environments' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--linked') options.linked = true;
    else if (takesValue[arg]) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      options[takesValue[arg]] = value;
      index += 1;
    } else throw new UsageError(`unknown option ${arg}`);
  }
  if (!options.variant) throw new UsageError('--variant is required');
  if (options.compare && !options.secrets) throw new UsageError('--compare needs --secrets');
  if (!options.envFile && !options.bundle && !options.secrets && !options.linked) throw new UsageError('choose at least one check');
  return options;
}

// Minimal dotenv reader for `eas env:pull` output: KEY=value, optional quotes, # comments.
function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.startsWith('#')) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    env[match[1]] = quote === '"' ? value.replace(/\\n/g, '\n') : value;
  }
  return env;
}

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (BUNDLE_FILES.test(entry.name)) files.push(full);
  }
  return files;
}

function linkedProjectRef(workdir) {
  try {
    const ref = JSON.parse(fs.readFileSync(path.join(workdir, 'supabase/.temp/linked-project.json'), 'utf8')).ref;
    if (typeof ref === 'string' && ref) return ref.trim();
  } catch { /* Older CLIs keep a plain project-ref file. */ }
  try {
    return fs.readFileSync(path.join(workdir, 'supabase/.temp/project-ref'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function run(argv, { cwd = process.cwd(), log = console.log } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    log(`release:check: ${error.message}\n${USAGE}`);
    return 2;
  }
  const resolve = (file) => path.resolve(cwd, file);
  const environments = JSON.parse(fs.readFileSync(options.environments ? resolve(options.environments) : path.join(root, 'release/environments.json'), 'utf8'));
  const backend = release.backendFor(environments, options.variant);
  const results = [];
  const check = (label, compute) => {
    let problems;
    try {
      problems = compute();
    } catch (error) {
      problems = [`could not run: ${error.code === 'ENOENT' ? `${error.path} does not exist` : error.message}`];
    }
    results.push({ label, problems });
  };

  if (options.envFile) {
    check(`app environment (${options.envFile})`, () => {
      const env = parseEnvFile(readText(resolve(options.envFile)));
      return release.checkMobileEnvironment({ variant: options.variant, env, environments }).problems;
    });
  }
  if (options.bundle) {
    check(`iOS export (${options.bundle})`, () => {
      const files = listFiles(resolve(options.bundle)).map((file) => ({ name: path.relative(resolve(options.bundle), file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'latin1') }));
      if (files.length === 0) return ['no exported JavaScript or bytecode found'];
      return release.scanBundle({ variant: options.variant, files, environments });
    });
  }
  if (options.secrets) {
    check(`function secrets (${options.secrets}${options.compare ? ` vs ${options.compare}` : ''})`, () => {
      if (!backend) return [`release/environments.json has no backend for the ${options.variant} variant`];
      const secrets = release.parseSecretsList(readText(resolve(options.secrets)));
      const other = options.compare ? release.parseSecretsList(readText(resolve(options.compare))) : undefined;
      const otherName = Object.keys(environments.backends).find((name) => name !== backend.name);
      return release.checkFunctionSecrets({ backendName: backend.name, secrets, environments, other, otherName });
    });
  }
  if (options.linked) {
    check('linked Supabase project', () => release.checkLinkedProject({ variant: options.variant, linkedRef: linkedProjectRef(cwd), environments }));
  }

  log(`release:check ${options.variant} → ${backend ? `${backend.name} (${backend.ref ?? 'project ref not recorded'})` : 'no backend'}`);
  for (const { label, problems } of results) {
    log(`${problems.length ? 'FAIL' : 'PASS'} ${label}`);
    for (const problem of problems) log(`  - ${problem}`);
  }
  const failed = results.filter((result) => result.problems.length).length;
  log(failed ? `${failed} of ${results.length} checks failed.` : `All ${results.length} checks passed.`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run, parseArgs, parseEnvFile, linkedProjectRef };
