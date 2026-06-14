import { get } from 'https';
import { readFileSync, writeFileSync } from 'fs';

get('https://api.ipify.org', r => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => {
    const ip = d.trim(), f = 'config.dev.toml', c = readFileSync(f, 'utf8');
    if (!c.includes(`"${ip}"`))
      writeFileSync(f, c.replace(/allowed_ips = \[.*?\]/, `allowed_ips = ["${ip}"]`)),
      console.log('Admin IP updated:', ip);
  });
});
