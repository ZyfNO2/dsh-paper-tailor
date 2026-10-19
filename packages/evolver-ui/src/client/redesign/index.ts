/**
 * Public surface of the redesigned workbench for the phase-3 wiring worker.
 *
 * WorkbenchView is props-driven (snapshot in, events out), performs no fetch
 * and reads no DSH context. The demo container is intentionally NOT exported
 * here; it belongs to the standalone preview only.
 */
export { WorkbenchView } from './WorkbenchView.tsx';
export type {
  WorkbenchViewProps,
  WorkbenchSnapshot,
  WorkbenchEvent,
  WorkbenchEventHandler,
  EventOutcome,
} from './view-model.ts';
export * from './view-model.ts';
// The host needs the receipt wording to decide what a `queued` result means on
// its side too (shared spec §7, FE-02 §6).
export { receiptText } from './research-actions.ts';
export type { BootstrapActions } from './research-actions.ts';
