/** Check bundle content with UTF-8-safe probes (console is GBK; -e strings get mangled). */
const fs = require('fs');
const s = fs.readFileSync(process.argv[2] ?? 'lib/client.js', 'utf8');
const probes = process.argv.slice(3);
for (const probe of probes) {
  console.log((s.includes(probe) ? 'OK   ' : 'MISS ') + probe);
}
console.log('bytes', s.length);
