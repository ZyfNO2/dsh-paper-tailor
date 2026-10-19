import fs from 'node:fs';import path from 'node:path';import YAML from 'yaml';
export function prepareModelProfile({source,forwardSettings,patchPath,model}) {
 const doc=YAML.parse(fs.readFileSync(source,'utf8'));const entries=[];
 function walk(o){if(!o||typeof o!=='object')return;if(o.id==='llm-pi-ai'||o.id==='agent-default-model')entries.push(structuredClone(o));for(const v of Object.values(o))if(v&&typeof v==='object')if(Array.isArray(v))v.forEach(walk);else walk(v);}walk(doc);
 const provider=entries.find(e=>e.id==='llm-pi-ai');const defaults=entries.find(e=>e.id==='agent-default-model');if(!provider||!defaults)throw Error('Source profile must provide llm-pi-ai and agent-default-model');
 if(model){const at=model.indexOf('/');if(at<1)throw Error('--model requires provider/model');defaults.config={provider:model.slice(0,at),model:model.slice(at+1)};}
 const selected=provider.config.providers[defaults.config.provider];if(!selected)throw Error('Default model provider is absent');
 if(selected.apiKeyEnv&&!process.env[selected.apiKeyEnv]&&forwardSettings){const settings=JSON.parse(fs.readFileSync(forwardSettings,'utf8'));const u=new URL(selected.baseURL);if(!['localhost','127.0.0.1'].includes(u.hostname)||String(settings.forward?.port)!==u.port||!settings.forwardKey)throw Error('Refusing unrelated forward credential');process.env[selected.apiKeyEnv]=settings.forwardKey;}
 if(selected.apiKeyEnv&&!process.env[selected.apiKeyEnv])throw Error('Configured model credential environment is unavailable');
 provider.config.providers={ [defaults.config.provider]: selected };
 const marker='# Private model overlay; verification home is excluded from release.';
 const existing=fs.readFileSync(patchPath,'utf8');
 fs.writeFileSync(patchPath,existing.split(marker)[0].trimEnd()+'\n\n'+marker+'\n'+YAML.stringify([{insert:entries}]));
 return {provider:defaults.config.provider,model:defaults.config.model};
}
