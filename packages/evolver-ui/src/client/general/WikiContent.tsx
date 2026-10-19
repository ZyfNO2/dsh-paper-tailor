import { Fragment, type ReactNode } from 'react';
import type { GeneralKnowledgeEntry } from '../../../../evolver/src/contracts/general-knowledge.ts';

/** React text nodes only: imported Markdown never executes HTML, scripts or arbitrary image URLs. */
export function WikiContent({ text, select }: { text: string; select?: (id: string) => void }) {
  const inline = (value: string): ReactNode[] => value.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link?.[2].startsWith('wiki:')) return <button key={i} className="link" onClick={() => select?.(link[2].slice(5))}>{link[1]}</button>;
    if (link && /^https?:\/\//i.test(link[2])) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
  let fenced = false;
  return <div className="wiki-prose">{text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_all, caption, target) => '图片引用待导入：' + caption + '（' + target + '）').split(/\r?\n/).map((line, i) => {
    if (line.startsWith('```')) { fenced = !fenced; return null; }
    if (fenced) return <pre key={i}>{line}</pre>;
    if (/^#{1,6} /.test(line)) return <h3 key={i}>{inline(line.replace(/^#+ /, ''))}</h3>;
    if (/^[-*] /.test(line)) return <div className="wiki-bullet" key={i}>• {inline(line.slice(2))}</div>;
    if (line.startsWith('> ')) return <blockquote key={i}>{inline(line.slice(2))}</blockquote>;
    return line ? <p key={i}>{inline(line)}</p> : <br key={i} />;
  })}</div>;
}
export function WikiImages({ entry, sourceUrl, allowed, expand }: { entry: GeneralKnowledgeEntry; sourceUrl: (id: string) => string; allowed: (id: string) => boolean; expand?: boolean }) {
  return <>{(entry.images ?? []).map(i => <figure key={i.sourceId}>{allowed(i.sourceId) ? <a href={sourceUrl(i.sourceId)} target="_blank" rel="noreferrer"><img loading="lazy" src={sourceUrl(i.sourceId)} alt={i.caption || '知识引用图片'} style={{ maxHeight: expand ? 500 : 140 }} /></a> : <p>图片来源已撤权</p>}<figcaption>{i.caption}</figcaption></figure>)}</>;
}
