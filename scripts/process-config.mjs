import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { parse, stringify } from 'smol-toml';

const [,, templatePath, configPath, skipPrompts] = process.argv;
const isTTY = process.stdin.isTTY && process.stdout.isTTY;
const interactive = isTTY && !['true', '1', 'yes'].includes(skipPrompts?.toLowerCase());

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

function parseValue(input, def) {
  if (Array.isArray(def)) {
    return input.split(',').map(v => {
      const val = v.trim();
      if (typeof def[0] === 'number') {
        const num = Number(val);
        if (isNaN(num)) throw new Error('Expected number');
        return num;
      }
      if (typeof def[0] === 'boolean') {
        if (['true', 'yes', '1'].includes(val.toLowerCase())) return true;
        if (['false', 'no', '0'].includes(val.toLowerCase())) return false;
        throw new Error('Expected boolean');
      }
      return val;
    });
  }

  if (typeof def === 'number') {
    const num = Number(input);
    if (isNaN(num)) throw new Error('Expected a number');
    return num;
  }

  if (typeof def === 'boolean') {
    if (['true', 'yes', '1'].includes(input.toLowerCase())) return true;
    if (['false', 'no', '0'].includes(input.toLowerCase())) return false;
    throw new Error('Expected boolean (true/false)');
  }

  return input;
}

function promptTyped(key, def) {
  return new Promise((resolve) => {
    const typeHint =
      Array.isArray(def) ? '(comma-separated list)' :
      typeof def === 'number' ? '(number)' :
      typeof def === 'boolean' ? '(true/false)' :
      '(string)';

    const ask = () => {
      rl.question(
        `[CONFIG] ${key} ${typeHint}\nDefault: ${JSON.stringify(def)}\nValue: `,
        (input) => {
          const val = input.trim();
          if (!val) {
            resolve(def);
            return;
          }
          try {
            resolve(parseValue(val, def));
          } catch (e) {
            console.log(`[WARN] ${e.message}`);
            ask();
          }
        }
      );
    };

    ask();
  });
}

async function merge(template, existing, prefix = '') {
  for (const key of Object.keys(template)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const def = template[key];

    if (!(key in existing)) {
      if (typeof def === 'object' && def !== null && !Array.isArray(def)) {
        existing[key] = {};
        await merge(def, existing[key], fullKey);
      } else {
        existing[key] = interactive ? await promptTyped(fullKey, def) : def;
      }
    } else if (
      typeof def === 'object' &&
      typeof existing[key] === 'object'
    ) {
      await merge(def, existing[key], fullKey);
    }
  }
}

async function main() {
  if (!interactive && !isTTY) {
    console.log('[WARN] Non-interactive mode (no TTY detected)');
  }

  let template = parse(fs.readFileSync(templatePath, 'utf-8'));
  let config = {};

  if (fs.existsSync(configPath)) {
    try {
      config = parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      console.error('[ERROR] Invalid existing config.toml');
      process.exit(1);
    }
  } else {
    console.log('[INFO] Creating new config');
  }

  await merge(template, config);

  const output = stringify(config).trim() + '\n';

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, output);

  console.log('[INFO] Config ready');
  rl.close();
  process.exit(0);
}

main();