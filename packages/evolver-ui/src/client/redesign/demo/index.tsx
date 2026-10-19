/**
 * Standalone preview entry for the redesigned workbench.
 *
 * Static page + local fixtures only: no /evolver/api calls, no auth, no DSH
 * context. Bundled by scripts/frontend-redesign/build-preview.mjs into
 * artifacts/frontend-redesign/site/app.js and served by serve-preview.mjs.
 */
import { createRoot } from 'react-dom/client';
import { DemoWorkbench } from './DemoWorkbench.tsx';

const el = document.getElementById('root');
if (el === null) throw new Error('missing #root');
createRoot(el).render(<DemoWorkbench />);
