/**
 * Inline stroke icons (no icon library dependency).
 * SPEC §2: icons reinforce kind/status so meaning never relies on color alone.
 */
import type { CSSProperties } from 'react';

export type IconName =
  | 'help'
  | 'bulb'
  | 'doc'
  | 'flask'
  | 'chart'
  | 'flag'
  | 'gear'
  | 'cube'
  | 'layers'
  | 'branch'
  | 'database'
  | 'code'
  | 'grid'
  | 'paper'
  | 'mechanism'
  | 'target'
  | 'link'
  | 'search'
  | 'filter'
  | 'external'
  | 'quote'
  | 'copy'
  | 'more'
  | 'plus'
  | 'close'
  | 'chevron'
  | 'warning'
  | 'blocked'
  | 'refresh'
  | 'experiment'
  | 'camera';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

const PATHS: Record<IconName, string> = {
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5.2v.05M9.6 9.1a2.4 2.4 0 1 1 3.4 2.18c-.72.34-1 .84-1 1.62',
  bulb: 'M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4M9.5 12h5M9.5 15.5h5M9.5 8.5h2',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M7.5 14h9',
  chart: 'M5 19V5m0 14h14M9 16v-5m4 5V8m4 8v-3',
  flag: 'M6 21V4m0 0h11l-2.5 3.5L17 11H6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.13-1.4l2-1.55-2-3.46-2.36.95a7.3 7.3 0 0 0-2.42-1.4L14.2 2H9.8l-.3 2.64a7.3 7.3 0 0 0-2.42 1.4l-2.35-.95-2 3.46 2 1.55a7.4 7.4 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95c.7.58 1.52 1.07 2.42 1.4l.3 2.64h4.4l.3-2.64c.9-.33 1.72-.82 2.42-1.4l2.36.95 2-3.46-2-1.55c.08-.46.12-.92.12-1.4Z',
  cube: 'M12 3 4 7v10l8 4 8-4V7l-8-4Zm0 0v9m8-5-8 4m0 0L4 6m8 8v8',
  layers: 'M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 17l9 5 9-5',
  branch: 'M6 4v16M6 8a12 12 0 0 0 12 4M18 8v8M15 16l3 3 3-3',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  code: 'm8 8-4 4 4 4m8-8 4 4-4 4m-2-10-4 14',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  paper: 'M7 3h10l3 3v15H7zM17 3v3h3M9.5 11h5M9.5 14.5h5M9.5 18h3',
  mechanism: 'M12 3a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V19h6v-1.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 3Zm-2 18h4',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-2.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  link: 'M10 14a4 4 0 0 0 6 .6l2.5-2.5a4 4 0 0 0-5.7-5.7L11.5 7.7M14 10a4 4 0 0 0-6-.6l-2.5 2.5a4 4 0 0 0 5.7 5.7l1.3-1.3',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l5 5',
  filter: 'M3 5h18l-7 8v5l-4 2v-7L3 5Z',
  external: 'M14 4h6v6m0-6L10 14M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6',
  quote: 'M7 7h4v4c0 3-1.8 4.8-4 6m10-10h4v4c0 3-1.8 4.8-4 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'm9 6 6 6-6 6',
  warning: 'M12 3 2 20h20L12 3Zm0 7v5m0 3v.05',
  blocked: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-6-6 12-6',
  refresh: 'M20 11A8 8 0 0 0 6.3 6.3L4 8m0-5v5h5M4 13a8 8 0 0 0 13.7 4.7L20 16m0 5v-5h-5',
  experiment: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M8 14h8l-1.6 3H9.6',
  camera: 'M3 8h4l2-2.5h6L17 8h4v11H3zM12 16.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
};

export function Icon({ name, size = 16, color = 'currentColor', strokeWidth = 1.7, style }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
