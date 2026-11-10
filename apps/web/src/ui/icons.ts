// A small set of line icons drawn for Parkwright (24×24, round caps, currentColor), so the HUD has one
// consistent look instead of platform emoji. icon('path') returns a fresh, aria-hidden <svg>.

const P: Record<string, string> = {
  select: 'M6 3l12 8-5.2 1.4L15.5 19l-2.4 1.2-2.7-6.3L6 18z',
  path: 'M4 20L9 4M20 20L15 4M12 6v2M12 11v2M12 16v2',
  queue: 'M5 20V9M12 20V9M19 20V9M5 11c2.3 2 4.7 2 7 0s4.7-2 7 0M4 20h2M11 20h2M18 20h2M5 9a.5.5 0 100-1M12 9a.5.5 0 100-1M19 9a.5.5 0 100-1',
  ride: 'M12 3V1.8M4 9.5C7 8 9.5 6 12 3c2.5 3 5 5 8 6.5M4 9.5c1.3 1.5 2.7 1.5 4 0 1.3 1.5 2.7 1.5 4 0 1.3 1.5 2.7 1.5 4 0 1.3 1.5 2.7 1.5 4 0M7 11.5V20M12 11.5V20M17 11.5V20M4 20h16M6 15.5h2M11 14.5h2M16 16.5h2',
  stall: 'M4 10V20h16V10M3 6h18l-1 4c-1 1.4-2.6 1.4-3.5 0-1 1.4-2.6 1.4-3.5 0-1 1.4-2.6 1.4-3.5 0-1 1.4-2.6 1.4-3.5 0zM9 20v-5h6v5',
  scenery: 'M12 21v-6M12 15c-4 0-6-2.4-6-5.2C6 6.4 8.7 3 12 3s6 3.4 6 6.8c0 2.8-2 5.2-6 5.2zM9 21h6M12 12l-2.2-2M12 11l2-2',
  bin: 'M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13M10.5 10.5v6.5M13.5 10.5v6.5',
  bulldoze: 'M15 4l5 5-9.5 9.5H6L3 15.5zM8.5 10.5l5.5 5.5M10.5 18.5H20',
  cash: 'M12 3a9 9 0 100 18 9 9 0 000-18zM14.8 9.2c-.5-1-1.5-1.5-2.8-1.5-1.6 0-2.8.8-2.8 2.1 0 3 5.8 1.5 5.8 4.4 0 1.3-1.2 2.1-3 2.1-1.4 0-2.5-.6-3-1.6M12 6v1.7M12 16.3V18',
  rating: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
  visitors: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3.5 20c.4-3.6 2.6-5.5 5.5-5.5s5.1 1.9 5.5 5.5M16 11a2.5 2.5 0 100-5M16.5 14.6c2.3.3 3.8 2 4 5.4',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4.5l12 7.5-12 7.5z',
  soundOn: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11',
  soundOff: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  finance: 'M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6M20 16V6',
  people: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3.5 20c.4-3.6 2.6-5.5 5.5-5.5s5.1 1.9 5.5 5.5M16 11a2.5 2.5 0 100-5M16.5 14.6c2.3.3 3.8 2 4 5.4',
  staff: 'M8 7.5a4 4 0 008 0M7 7.5h10M9 4.5c0-1 1.3-1.5 3-1.5s3 .5 3 1.5v3H9zM5 21c.5-4.2 3.3-6.5 7-6.5s6.5 2.3 7 6.5M10.5 14.5L12 18l1.5-3.5',
  parks: 'M5 21V4M5 4.5c4-2 6 2 10 0s4 0 4 0v8s-1-2-4 0-6-2-10 0',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 16.8v.2',
  close: 'M6 6l12 12M18 6L6 18',
  coaster: 'M3 19c3-9 5-12 7-12s3 6 5 6 3-4 6-6M3 19h18M7 19v-6.5M11 19V9M15 19v-6M19 19v-9',
  flag: 'M5 21V4M5 4.5c4-2 6 2 10 0s4 0 4 0v8s-1-2-4 0-6-2-10 0',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 16H3zM12 10v4.5M12 17.2v.3',
  path2: 'M3 7l9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  wheel: 'M12 3.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM12 10v0M12 3.5v13M5.5 10h13M7.4 5.4l9.2 9.2M16.6 5.4l-9.2 9.2M9 21l3-11 3 11M7 21h10',
  food: 'M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10M16 21V3c-2.5 1.5-3.5 4-3.5 7.5V13H16',
};

export type IconName = keyof typeof P;

const NS = 'http://www.w3.org/2000/svg';
export function icon(name: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', P[name] ?? P.sparkle);
  svg.append(p);
  return svg;
}
