/**
 * A static, masked HTML copy of the page for session replay.
 *
 * Works on a detached clone, so the live page is never touched. What is kept
 * and what is not:
 * - removed: `script`, `noscript`, `iframe`, `frame`, `object`, `embed`,
 *   `template`, every `on*` attribute and every `javascript:` URL;
 * - blanked: the value of every `input`, `textarea` and `select`, and the
 *   checked/selected state of choices;
 * - removed: any element marked `data-errorgap-block`;
 * - masked: text inside `data-errorgap-mask` becomes `•` of the same length.
 *
 * A `<base>` pointing at the page's origin keeps relative stylesheet and image
 * URLs working when the snapshot is shown in the viewer's sandboxed frame.
 */

/** Largest snapshot sent; the server drops anything bigger. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;

const REMOVED_TAGS = ["script", "noscript", "iframe", "frame", "object", "embed", "template"];
const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href"];

export function serializeSnapshot(doc: Document = document): string | null {
  const root = doc.documentElement;
  if (!root) return null;
  const clone = root.cloneNode(true) as HTMLElement;

  for (const el of Array.from(clone.querySelectorAll("[data-errorgap-block]"))) el.remove();
  for (const el of Array.from(clone.querySelectorAll(REMOVED_TAGS.join(",")))) el.remove();

  for (const el of Array.from(clone.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRIBUTES.includes(name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  for (const input of Array.from(clone.querySelectorAll("input"))) {
    input.removeAttribute("value");
    input.removeAttribute("checked");
  }
  for (const area of Array.from(clone.querySelectorAll("textarea"))) area.textContent = "";
  for (const option of Array.from(clone.querySelectorAll("option"))) option.removeAttribute("selected");

  for (const masked of Array.from(clone.querySelectorAll("[data-errorgap-mask]"))) maskText(masked);

  addBase(clone, doc);

  const html = `<!doctype html>${clone.outerHTML}`;
  return byteLength(html) <= MAX_SNAPSHOT_BYTES ? html : null;
}

function maskText(el: Element): void {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    node.data = node.data.replace(/\S/g, "•");
  }
}

function addBase(clone: HTMLElement, doc: Document): void {
  const origin = doc.location?.origin;
  if (!origin || origin === "null") return;
  const head = clone.querySelector("head");
  if (!head || head.querySelector("base")) return;
  const base = doc.createElement("base");
  base.setAttribute("href", `${origin}/`);
  head.insertBefore(base, head.firstChild);
}

function byteLength(text: string): number {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length * 3;
}
