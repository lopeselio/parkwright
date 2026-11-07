export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== false) el.append(c);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
export const cr = (cents: number) => `${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })} cr`;

let toastTimer = 0;
export function toast(msg: string, kind: 'ok' | 'err' = 'ok', hint?: string) {
  const el = $('#toast');
  el.className = `toast show ${kind}`;
  el.replaceChildren(h('div', {}, msg), hint ? h('div', { class: 'hint' }, hint) : '');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), kind === 'err' ? 4200 : 2200);
}
