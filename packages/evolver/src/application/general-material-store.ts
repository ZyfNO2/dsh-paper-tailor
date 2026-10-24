import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { activeStore } from '../../../research-core/src/active-store.ts';
import { DATA_LIMITS, validateParsedMaterial, type ParsedMaterial, type MaterialSource } from '../contracts/general-data.ts';
import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { parseTextMaterial, XLSX_PARSER_SCRIPT } from './general-material-parser.ts';

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export interface MaterialStoreOptions { pythonPath?: string; parserTimeoutMs?: number }
/** Content-addressed raw/parsed storage; metadata and ownership stay in Bootstrap CAS. */
export class GeneralMaterialStore {
  readonly workspaceRoot: string;
  readonly options: MaterialStoreOptions;
  constructor(workspaceRoot: string, options: MaterialStoreOptions = {}) {
    const selected = activeStore(workspaceRoot);
    this.workspaceRoot = selected ? path.resolve(workspaceRoot, selected.root) : path.resolve(workspaceRoot); this.options = options;
  }

  private location(parts: string[], create = false): string {
    if (activeStore(this.workspaceRoot)) throw new BootstrapError('POLICY_DENIED', 'STORE_MOVED: reopen material store after migration');
    if (!fs.existsSync(this.workspaceRoot)) throw new BootstrapError('SOURCE_MISSING', '工作区目录不存在。');
    if (fs.lstatSync(this.workspaceRoot).isSymbolicLink()) throw new BootstrapError('POLICY_DENIED', '资料存储不接受符号链接工作区。');
    let current = this.workspaceRoot;
    for (const part of ['.dsh', 'research', 'materials', ...parts]) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') throw new BootstrapError('POLICY_DENIED', '非法资料存储标识。');
      current = path.join(current, part);
      if (!fs.existsSync(current)) { if (!create) throw new BootstrapError('SOURCE_MISSING', '原始文件或解析产物缺失。'); fs.mkdirSync(current); }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BootstrapError('POLICY_DENIED', '资料存储路径包含链接或非目录。');
    }
    return current;
  }

  private blobLocation(hash: string, kind: 'raw' | 'parsed', create = false): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new BootstrapError('INVALID_INPUT', '资料 hash 非法。');
    return path.join(this.location([kind], create), hash);
  }
  /** Page text extracted by the PDF reader, pinned to the raw file hash. Not a substitute for the raw bytes. */
  writePdfPages(sourceSha256: string, pages: readonly string[]): string {
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new BootstrapError('INVALID_INPUT', 'PDF 来源 hash 非法。');
    if (pages.length === 0 || pages.length > 300) throw new BootstrapError('INVALID_INPUT', 'PDF 页文本必须在 1–300 页之间。');
    if (pages.some((page) => typeof page !== 'string')) throw new BootstrapError('INVALID_INPUT', 'PDF 页文本必须是字符串。');
    if (pages.join('').length > 2_000_000) throw new BootstrapError('INVALID_INPUT', 'PDF 提取文本超过 200 万字符。');
    const body = Buffer.from(JSON.stringify({ sourceSha256, pages }), 'utf8');
    const pagesSha256 = sha256(body);
    const target = path.join(this.location(['pdf-pages'], true), pagesSha256);
    if (!fs.existsSync(target)) {
      const temporary = path.join(this.location(['pdf-pages'], true), `.${pagesSha256}.${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, body);
      fs.renameSync(temporary, target);
    }
    return pagesSha256;
  }

  readPdfPages(pagesSha256: string): { sourceSha256: string; pages: string[] } {
    if (!/^[a-f0-9]{64}$/.test(pagesSha256)) throw new BootstrapError('INVALID_INPUT', 'PDF 页文本 hash 非法。');
    const target = path.join(this.location(['pdf-pages']), pagesSha256);
    const body = fs.readFileSync(target);
    if (sha256(body) !== pagesSha256) throw new BootstrapError('SOURCE_STALE', 'PDF 页文本与登记 hash 不一致。');
    const parsed = JSON.parse(body.toString('utf8')) as { sourceSha256?: unknown; pages?: unknown };
    if (typeof parsed.sourceSha256 !== 'string' || !Array.isArray(parsed.pages) || parsed.pages.some((page) => typeof page !== 'string')) {
      throw new BootstrapError('SOURCE_STALE', 'PDF 页文本记录无法读取。');
    }
    return { sourceSha256: parsed.sourceSha256, pages: parsed.pages };
  }

  persist(bytes: Buffer, parsed: ParsedMaterial): { sha256: string; parsedSha256: string } {
    const parsedBytes = Buffer.from(JSON.stringify(validateParsedMaterial(parsed)), 'utf8');
    const rawHash = sha256(bytes), parsedHash = sha256(parsedBytes);
    for (const [buffer, hash, kind] of [[bytes, rawHash, 'raw'], [parsedBytes, parsedHash, 'parsed']] as const) {
      const target = this.blobLocation(hash, kind, true);
      if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile() || sha256(fs.readFileSync(target)) !== hash) throw new BootstrapError('SOURCE_STALE', '内容寻址资料被更改，拒绝覆盖。');
        continue;
      }
      // Exclusive writes: a concurrent identical upload cannot overwrite a blob.
      try { fs.writeFileSync(target, buffer, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.lstatSync(target).isSymbolicLink() || sha256(fs.readFileSync(target)) !== hash) throw error;
      }
    }
    return { sha256: rawHash, parsedSha256: parsedHash };
  }

  private readBlob(hash: string, kind: 'raw' | 'parsed'): Buffer {
    const file = this.blobLocation(hash, kind);
    if (!fs.existsSync(file)) throw new BootstrapError('SOURCE_MISSING', '资料文件缺失。');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BootstrapError('POLICY_DENIED', '资料文件类型非法。');
    const max = kind === 'raw' ? DATA_LIMITS.maxFileBytes : 64 * 1024 * 1024;
    if (stat.size > max) throw new BootstrapError('SOURCE_STALE', '资料文件超限或被修改。');
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== hash) throw new BootstrapError('SOURCE_STALE', '资料 hash 不一致；不能作为当前计算输入。');
    return bytes;
  }
  readRaw(source: MaterialSource): Buffer { const bytes = this.readBlob(source.sha256, 'raw'); if (bytes.length !== source.bytes) throw new BootstrapError('SOURCE_STALE', '原始资料大小不一致。'); return bytes; }
  readParsed(source: MaterialSource): ParsedMaterial {
    this.readRaw(source);
    const parsed = validateParsedMaterial(JSON.parse(this.readBlob(source.parsedSha256, 'parsed').toString('utf8')));
    if (parsed.parser !== source.parser) throw new BootstrapError('SOURCE_STALE', '解析器版本不一致。');
    return parsed;
  }

  parse(filename: string, bytes: Buffer): ParsedMaterial {
    if (bytes.length > DATA_LIMITS.maxFileBytes) throw new BootstrapError('INVALID_INPUT', '单文件超过 10 MiB；请分批，不会静默截断。');
    if (!filename.toLowerCase().endsWith('.xlsx')) return parseTextMaterial(filename, bytes);
    const staging = this.location(['staging'], true);
    const token = randomUUID();
    const input = path.join(staging, `${token}.xlsx`), output = path.join(staging, `${token}.json`);
    fs.writeFileSync(input, bytes, { flag: 'wx' });
    // Default corresponds to the installed bundled runtime; hosts may supply a trusted override.
    const python = this.options.pythonPath ?? process.env.DSH_RESEARCH_PYTHON ?? path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
    try {
      const result = spawnSync(python, ['-I', '-c', XLSX_PARSER_SCRIPT, input, output], { stdio: 'ignore', timeout: this.options.parserTimeoutMs ?? 20000, windowsHide: true });
      if (result.error || result.status !== 0) return { parser: 'dsh-xlsx-parser/1', tables: [], error: { code: result.error ? 'PARSER_UNAVAILABLE' : 'PARSE_FAILED', message: `XLSX 解析未完成；未执行公式或宏。${result.error?.message ?? `进程退出 ${result.status}`}`.slice(0, 4000) } };
      if (!fs.existsSync(output) || fs.statSync(output).size > 64 * 1024 * 1024) throw new Error('解析产物缺失或超限。');
      return validateParsedMaterial(JSON.parse(fs.readFileSync(output, 'utf8')));
    } catch (error) { return { parser: 'dsh-xlsx-parser/1', tables: [], error: { code: 'PARSE_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) } }; }
    finally {
      // Targets are fixed trusted staging filenames, never derived from uploaded filenames.
      for (const file of [input, output]) if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
    }
  }
}
