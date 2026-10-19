import { BootstrapError } from '../contracts/research-bootstrap.ts';
import type { GeneralResearch } from '../contracts/general-research.ts';

/** Research evidence-use policy. Owners retain historical metadata; tasks/reports may not reuse withdrawn evidence. */
export function generalSourceAllowed(g: GeneralResearch, sourceId: string): boolean {
  if (!g.sources.some(s => s.sourceId === sourceId)) return false;
  return [...g.sourceAccess].reverse().find(p => p.sourceId === sourceId)?.allowed ?? true;
}
export function assertGeneralSourceAccess(g: GeneralResearch, sourceId: string, assignedSourceIds?: readonly string[]): void {
  if (!g.sources.some(s => s.sourceId === sourceId)) throw new BootstrapError('SOURCE_MISSING', 'Evidence source does not belong to this research；来源不属于该研究');
  if (assignedSourceIds && !assignedSourceIds.includes(sourceId)) throw new BootstrapError('POLICY_DENIED', 'Evidence source is outside the host-assigned task scope');
  if (!generalSourceAllowed(g, sourceId)) throw new BootstrapError('POLICY_DENIED', 'Evidence source access has been revoked; cached inputs cannot restore permission');
}
