// Runs INSIDE the page (via page.evaluate, which is not subject to the page's CSP). Plain JS on purpose: no transpiler helpers.
// Returns a list of layout problems found in the current rendering. Each check is one a human reviewer would otherwise do by eye.
({ touch }) => {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  const describe = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "");
  const isScroller = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (isScroller(p)) return true; return false; };
  const clips = (el) => { const s = getComputedStyle(el); return /(hidden|clip)/.test(s.overflowX) || /(hidden|clip)/.test(s.overflowY); };
  // Content of a closed <details> (outside its <summary>) has layout boxes but is not painted, so it cannot overlap anything.
  const hiddenEl = (el) => {
    let inSummary = false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden") return true;
      if (p.tagName === "SUMMARY") inSummary = true;
      if (p.tagName === "DETAILS" && !p.open && !inSummary) return true;
    }
    return false;
  };
  // vertical slack is a fraction of the line, because a font's content box can be a little taller than a tight line-height
  const within = (r, box, tol) => { const v = Math.max(tol, r.height * 0.15); return r.left >= box.left - tol && r.right <= box.right + tol && r.top >= box.top - v && r.bottom <= box.bottom + v; };
  const overlays = (el) => { for (let p = el; p; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === "fixed" || pos === "sticky") return true; } return false; };

  if (document.documentElement.scrollWidth > vw + 1) problems.push({ kind: "page-overflow", detail: "page is " + document.documentElement.scrollWidth + "px wide in a " + vw + "px viewport" });

  // every rendered line of text
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!node.nodeValue.trim() || !el || /^(SCRIPT|STYLE|TITLE|NOSCRIPT|OPTION)$/.test(el.tagName) || hiddenEl(el) || inScroller(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0.5 && r.height > 0.5) lines.push({ el, node, r, text: node.nodeValue.trim().slice(0, 40) });
  }

  for (const { el, r, text } of lines) {
    // outside the viewport
    if (r.right > vw + 1 || r.left < -1) problems.push({ kind: "text-outside-viewport", detail: describe(el) + ' "' + text + '"' });
    // spilling out of its own container (nearest non-inline box; for treemap labels, the cell rectangle)
    let container = null;
    if (el.closest(".tm-cell")) container = el.closest(".tm-cell").querySelector("rect");
    else { container = el; while (container && getComputedStyle(container).display === "inline") container = container.parentElement; }
    if (container && !within(r, container.getBoundingClientRect(), 1.5)) problems.push({ kind: "text-spills-container", detail: describe(el) + ' "' + text + '" leaves ' + describe(container) });
    // clipped by an ancestor that hides overflow
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (clips(a) && !within(r, a.getBoundingClientRect(), 1.5)) { problems.push({ kind: "text-clipped", detail: describe(el) + ' "' + text + '" is cut off by ' + describe(a) }); break; }
    }
  }

  // two different pieces of text drawn on top of each other
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i], b = lines[j];
      if (a.node === b.node) continue;
      if (overlays(a.el) !== overlays(b.el)) continue; // the fixed tab bar and sticky header float over content by design; the end of the page is checked separately
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 3 && oy > 3) problems.push({ kind: "text-overlap", detail: describe(a.el) + ' "' + a.text + '" overlaps ' + describe(b.el) + ' "' + b.text + '"' });
    }
  }

  // touch targets
  if (touch) {
    for (const el of document.querySelectorAll(".tabbar a, .btn, .row-btn, .row-link, .chip-link, .tree-item, input, select, textarea, summary")) {
      if (hiddenEl(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) problems.push({ kind: "small-touch-target", detail: describe(el) + " is " + Math.round(r.width) + "x" + Math.round(r.height) });
    }
  }
  return problems;
}
