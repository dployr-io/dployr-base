const fs = require('fs');
const path = require('path');

const [,, templatePath, configPath, skipPrompts] = process.argv;
const interactive = skipPrompts !== 'true';

const toml = require('toml');

function stringify(obj) {
  let out = '';

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out += `\n[${key}]\n`;
      out += stringify(value);
    } else {
      const v = typeof value === 'string' ? `"${value}"` : value;
      out += `${key} = ${v}\n`;
    }
  }

  return out;
}

function prompt(question, def) {
  process.stdout.write(`\n[CONFIG] ${question}\nDefault: ${def}\nValue: `);
  try {
    const input = fs.readFileSync(0, 'utf-8').trim();
    return input || def;
  } catch {
    return def;
  }
}

function merge(template, existing, prefix = '') {
  for (const key of Object.keys(template)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (!(key in existing)) {
      const def = template[key];

      if (typeof def === 'object' && def !== null && !Array.isArray(def)) {
        existing[key] = {};
        merge(def, existing[key], fullKey);
      } else {
        existing[key] = interactive ? prompt(fullKey, def) : def;
      }
    } else if (
      typeof template[key] === 'object' &&
      typeof existing[key] === 'object'
    ) {
      merge(template[key], existing[key], fullKey);
    }
  }
}

let template = toml.parse(fs.readFileSync(templatePath, 'utf-8'));
let config = {};

if (fs.existsSync(configPath)) {
  try {
    config = toml.parse(fs.readFileSync(configPath, 'utf-8'));
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
