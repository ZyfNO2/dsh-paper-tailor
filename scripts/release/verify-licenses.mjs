import fs from 'node:fs';import path from 'node:path';import { createHash } from 'node:crypto';import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const sha=b=>createHash('sha256').update(b).digest('hex');
if(!fs.readFileSync(path.join(root,'LICENSE'),'utf8').startsWith('MIT License'))throw Error('Project MIT license missing');
const provenance=JSON.parse(fs.readFileSync(path.join(root,'tools/vendor/provenance.json')));
for(const p of provenance.packages){const base=path.join(root,'tools/vendor',p.name);if(p.license!=='MIT'||sha(fs.readFileSync(path.join(base,'LICENSE')))!==p.licenseSha256)throw Error('License mismatch '+p.name);for(const f of p.sourceFiles)if(sha(fs.readFileSync(path.join(base,f.path)))!==f.sha256)throw Error('Vendor source drift '+p.name+'/'+f.path);for(const f of p.generatedDeclarations)if(sha(fs.readFileSync(path.join(root,f.path)))!==f.sha256)throw Error('Declaration pin drift '+f.path);}
if(!fs.existsSync(path.join(root,'THIRD_PARTY_NOTICES.md')))throw Error('Third-party notices missing');
console.log('PASS project MIT and '+provenance.packages.length+' attributed vendor packages with source/declaration hashes');
