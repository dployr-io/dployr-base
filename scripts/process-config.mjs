import fs from 'fs';
import path from 'path';
import { parse, stringify } from 'smol-toml';

const [,, templatePath, configPath, skipPrompts] = process.argv;
const interactive = !['true', '1', 'yes'].includes(skipPrompts?.toLowerCase());

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
  while (true) {
    let hint = '';
    if (Array.isArray(def)) hint = '(comma-separated list)';
    else if (typeof def === 'number') hint = '(number)';
    else if (typeof def === 'boolean') hint = '(true/false)';
    else hint = '(string)';

    process.stdout.write(
      `\n[CONFIG] ${key} ${hint}\nDefault: ${JSON.stringify(def)}\nValue: `
    );

    try {
      const input = fs.readFileSync(0, 'utf-8').trim();
      if (!input) return def;
      return parseValue(input, def);
    } catch (err) {
      console.log(`[WARN] Invalid input: ${err.message}`);
    }
  }
}

function merge(template, existing, prefix = '') {
  for (const key of Object.keys(template)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const def = template[key];

    if (!(key in existing)) {
      if (typeof def === 'object' && def !== null && !Array.isArray(def)) {
        existing[key] = {};
        merge(def, existing[key], fullKey);
      } else {
        existing[key] = interactive ? promptTyped(fullKey, def) : def;
      }
    } else if (
      typeof def === 'object' &&
      typeof existing[key] === 'object'
    ) {
      merge(def, existing[key], fullKey);
    }
  }
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

merge(template, config);

const output = stringify(config).trim() + '\n';

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, output);

console.log('[INFO] Config ready');
process.exit(0);
