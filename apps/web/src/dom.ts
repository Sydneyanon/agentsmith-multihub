/**
 * Minimal element builder. Every string becomes a text node via textContent / createTextNode; there is no
 * innerHTML anywhere in the client, so repository text, claims and rationales can never become markup.
 */
export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

const SVG_NS = "http://www.w3.org/2000/svg";

function apply(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") { el.addEventListener(key.replace(/^on/, ""), value); continue; }
    if (key === "class") el.setAttribute("class", String(value));
    // CSSOM assignment is allowed by the strict CSP; a style="" attribute would be blocked.
    else if (key === "style") (el as HTMLElement).style.cssText = String(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }
export function mount(el: Element, ...children: Child[]): void { clear(el); append(el, children); }
