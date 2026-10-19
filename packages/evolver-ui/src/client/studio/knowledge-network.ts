import type { StudioCard } from './studio-model.ts';
export type KnowledgeRelationKind = 'source' | 'wikilink' | 'related' | 'evidence';
export interface KnowledgeNode { id: string; title: string; type: string; category: string; version: string; readable: boolean; url?: string }
export interface KnowledgeEdge { id: string; from: string; to: string; kind: KnowledgeRelationKind; label: string; available?: boolean }
export interface KnowledgeNetwork { nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; broken: Array<{ from: string; target: string }> }
/** Resolve only stable IDs or an unambiguous exact title, never keyword similarity. */
export function resolveKnowledgeTarget(target: string, cards: StudioCard[]): string | null {
 const value=target.split('#')[0].trim().replace(/\.md$/i,'');
 const byId=cards.find(c=>c.id===value);if(byId)return byId.id;
 const matches=cards.filter(c=>c.title===value);return matches.length===1?matches[0].id:null;
}
export function knowledgeTextLinks(text: string): string[] {
 const body=text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,'').replace(/`[^`]*`/g,'');
 return [...new Set([...body.matchAll(/\[\[([^\]\n]+)\]\]|(?<!!)\[[^\]\n]+\]\(wiki:([^\s)]+)\)/g)].map(m=>(m[1]?.split('|')[0]??m[2]).trim()))];
}
export function knowledgeIndexMarkdown(title: string, cards: StudioCard[], network: KnowledgeNetwork): string {
 const clean=(s:string)=>s.replace(/[\r\n]/g,' ').replace(/[\[\]]/g,'');
 return `# ${clean(title)} · Wiki Index\n\n条目索引由当前持久快照生成；关系表示引用或组织联系，不代表科学结论。\n\n`+cards.map(c=>{const node=network.nodes.find(n=>n.id===c.id);const links=network.edges.filter(e=>e.from===c.id||e.to===c.id);return `- [${clean(c.title)}](wiki:${encodeURIComponent(c.id)}) — ${clean(node?.category??c.kind)} · ${clean(node?.version??'版本未记录')} · ${links.length} 条关系 · ${clean(c.status)}\n  - 身份：${c.id}\n  - 来源：${clean(c.source)}`;}).join('\n')+'\n';
}
/** Bounded, deterministic spring layout; the UI can persist coordinates separately. */
export function knowledgeNetworkLayout(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): Record<string,{x:number;y:number}> {
 const degree=new Map(nodes.map(n=>[n.id,edges.filter(e=>e.from===n.id||e.to===n.id).length]));
 const ranked=[...nodes].sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0)||a.id.localeCompare(b.id));
 const points=Object.fromEntries(ranked.map((n,i)=>[n.id,{x:590+Math.cos(i*2.399963)*Math.sqrt(i)*70,y:380+Math.sin(i*2.399963)*Math.sqrt(i)*55}]));
 if(nodes.length>180)return points;
 for(let step=0;step<100;step++){
  const force=Object.fromEntries(nodes.map(n=>[n.id,{x:0,y:0}]));
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=points[nodes[i].id],b=points[nodes[j].id],dx=a.x-b.x,dy=a.y-b.y,d=Math.max(25,Math.hypot(dx,dy)),f=5600/(d*d);force[nodes[i].id].x+=dx/d*f;force[nodes[i].id].y+=dy/d*f;force[nodes[j].id].x-=dx/d*f;force[nodes[j].id].y-=dy/d*f;}
  for(const e of edges){const a=points[e.from],b=points[e.to];if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-175)*.012;force[e.from].x+=dx/d*f;force[e.from].y+=dy/d*f;force[e.to].x-=dx/d*f;force[e.to].y-=dy/d*f;}
  for(const n of nodes){const p=points[n.id],f=force[n.id];p.x+=Math.max(-8,Math.min(8,f.x+(590-p.x)*.003));p.y+=Math.max(-8,Math.min(8,f.y+(380-p.y)*.003));}
 }
 return points;
}
