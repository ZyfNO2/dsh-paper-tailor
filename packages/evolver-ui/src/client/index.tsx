/**
 * dsh-evolver-ui client half: register the 工作台 view into `conversation.view`.
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md sections 7.3/8.1. The chat and
 * trajectory views stay untouched; this file adds ONE list entry (id
 * `evolver-workbench`, label 工作台) beside them. The component receives only
 * props/callbacks (framework standard props + the slot's owner props); it
 * never touches the Cordis ctx.
 *
 * Type note: the slot contract used here (`conversation.view` as a list slot
 * with id/order/label) is mirrored structurally instead of imported from the
 * owning package, matching the third-party plugin convention. Registering
 * against an undeclared key fails loudly at activation, so a drift shows up as
 * a failed mount, not a silent no-op.
 *
 * Props note: the `session` slot scope binds `props: { sessionId }`
 * (`dsh-client-ui-session`), so the workbench receives the id of the session it
 * is rendered under and asks the host for a read capability on THAT session. The
 * component is registered as-is; the slot injects the standard props itself.
 */
import { Workbench } from './Workbench.tsx';
import { DshWorkbench } from './integration/DshWorkbench.tsx';
import { ensureResearchSkillMenuStyles } from './skill-menu-styles.ts';

// Explicit escape hatch for existing v2/v3 users; the requested redesign is the
// production default. This selects a view only and cannot change authorization.
const WorkbenchEntry = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('evolverView') === 'legacy'
  ? Workbench : DshWorkbench;

export const inject: readonly string[] = ['slots'];

interface ViewRegistration {
  name: 'conversation.view';
  id: string;
  order: number;
  label: string;
}

interface ClientSlotContext {
  slots: { inject(name: string, callback: () => unknown): void; register(registration: ViewRegistration, component: typeof WorkbenchEntry): unknown };
}

export function apply(ctx: ClientSlotContext): void {
  ensureResearchSkillMenuStyles();
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'evolver-workbench',
        order: 20,
        label: '工作台',
      } as unknown as never,
      WorkbenchEntry as never,
    ),
  );
}
