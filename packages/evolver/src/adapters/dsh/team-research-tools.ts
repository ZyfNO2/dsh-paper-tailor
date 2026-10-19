/** Concrete, member-local tools: no generic shell or arbitrary source resolver. */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ExperimentError, expAssertArtifactRef, expAssertId, expNoExtraKeys } from '../../contracts/experiments.ts';
import type { ResearchMemberAccess, TrustedResearchTool } from './team-research-runtime.ts';

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
};

function caller(access: ResearchMemberAccess, exec: ToolRunContext, toolName: string): unknown {
  // Check actual caller again in the body, even if dispatch bypasses a guard.
  access.authorize(exec.agent, toolName);
  return exec.agent;
}

export function createResearchFileToolCatalog(): ReadonlyMap<string, TrustedResearchTool> {
  return new Map<string, TrustedResearchTool>([
    ['evolver_research_read_file', {
      effect: 'read', create: (access) => defineTool({
        name: 'evolver_research_read_file',
        description: 'Read a bounded regular file within this member read ACL. Returns content as base64 and an exact byte hash.',
        parameters: { path: { type: 'string', required: true } }, output,
        execute: (raw: unknown, exec: ToolRunContext) => {
          caller(access, exec, 'evolver_research_read_file');
          const args = expNoExtraKeys(raw, ['path'], 'read_file');
          const file = expAssertId(args.path, 'path');
          const result = access.workspace.readFile(file);
          return { path: file, sha256: result.sha256, contentBase64: result.bytes.toString('base64') };
        },
      }),
    }],
    ['evolver_research_write_file', {
      effect: 'write', create: (access) => defineTool({
        name: 'evolver_research_write_file',
        description: 'Write bounded bytes inside this member write ACL. Omit expectedSha256 for create-only; overwrites require the current hash.',
        parameters: {
          path: { type: 'string', required: true }, contentBase64: { type: 'string', required: true },
          expectedSha256: { type: 'string', required: false, description: 'Exact current hash; omit only for create-only writes.' },
        }, output,
        execute: (raw: unknown, exec: ToolRunContext) => {
          caller(access, exec, 'evolver_research_write_file');
          const args = expNoExtraKeys(raw, ['path', 'contentBase64', 'expectedSha256'], 'write_file');
          const file = expAssertId(args.path, 'path');
          if (typeof args.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.contentBase64)) {
            throw new ExperimentError('SCHEMA_VIOLATION', 'contentBase64 must be canonical padded base64');
          }
          const bytes = Buffer.from(args.contentBase64, 'base64');
          if (bytes.toString('base64') !== args.contentBase64) throw new ExperimentError('SCHEMA_VIOLATION', 'Noncanonical base64 bytes');
          const expected = args.expectedSha256 === undefined ? null : args.expectedSha256;
          if (expected !== null && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) {
            throw new ExperimentError('SCHEMA_VIOLATION', 'expectedSha256 must be an exact SHA256');
          }
          return access.workspace.writeFile(file, bytes, expected as string | null);
        },
      }),
    }],
    ['evolver_research_read_input', {
      effect: 'read', create: (access) => defineTool({
        name: 'evolver_research_read_input',
        description: 'Read only an exact published input ref admitted to this fresh member context.',
        parameters: {
          inputRef: { type: 'object', required: true, additionalProperties: false, properties: {
            id: { type: 'string', required: true }, sha256: { type: 'string', required: true },
          } },
        }, output,
        execute: (raw: unknown, exec: ToolRunContext) => {
          const agent = caller(access, exec, 'evolver_research_read_input');
          const args = expNoExtraKeys(raw, ['inputRef'], 'read_input');
          const inputRef = expAssertArtifactRef(args.inputRef, 'inputRef');
          const bytes = access.readInput(agent, inputRef);
          return { inputRef, contentBase64: bytes.toString('base64') };
        },
      }),
    }],
  ]);
}
