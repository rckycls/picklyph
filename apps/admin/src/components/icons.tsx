// Line icons for the console chrome. Decorative only: every use sits next to visible text.
const PATHS = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  directory: <><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>,
  ownership: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="m16 11 2 2 4-4" /></>,
  reports: <><path d="M5 21V4" /><path d="M5 4h12l-2.5 4 2.5 4H5" /></>,
  registrations: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h6M9 18h3" /></>,
  health: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  upload: <><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
};
export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[name]}</svg>;
}
