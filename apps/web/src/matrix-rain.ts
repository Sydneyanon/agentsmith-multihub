/**
 * AgentSmith signature: a subtle Matrix "digital rain" behind the hub. Pure canvas 2D (CSP-safe: no inline script, no eval). It sits
 * at the very back, is pointer-transparent, throttled and paused when the tab is hidden, and honours prefers-reduced-motion (a faint
 * static sprinkle instead of motion). Opacity is low so it never competes with content — it shows in the page gutters and behind the
 * unlock screen.
 */
const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEFﾊﾋﾌﾍﾎ<>/\\*+=:".split("");
const FONT = 16;      // glyph cell size in px
const FPS = 18;       // throttled for subtlety and battery

export function startMatrixRain(): void {
  if (typeof document === "undefined" || document.querySelector("canvas.matrix-rain")) return;
  const canvas = document.createElement("canvas");
  canvas.className = "matrix-rain";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) { canvas.remove(); return; }

  let w = 0, h = 0, cols = 0, drops: number[] = [];
  const resize = () => {
    w = canvas.width = Math.max(1, window.innerWidth);
    h = canvas.height = Math.max(1, window.innerHeight);
    cols = Math.ceil(w / FONT);
    drops = Array.from({ length: cols }, () => Math.floor(Math.random() * -40));
  };
  resize();
  window.addEventListener("resize", resize);

  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    ctx.font = `${FONT}px ui-monospace, monospace`;
    ctx.fillStyle = "rgba(43,255,136,0.18)";
    for (let i = 0; i < cols; i++) for (let y = 0; y < h; y += FONT * 3) if (Math.random() > 0.88) ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0]!, i * FONT, y);
    return;
  }

  let last = 0, raf = 0, running = true;
  const frame = (t: number) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (t - last < 1000 / FPS) return;
    last = t;
    // Fade the previous frame slightly to leave glowing trails.
    ctx.fillStyle = "rgba(4,8,6,0.09)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${FONT}px ui-monospace, monospace`;
    for (let i = 0; i < cols; i++) {
      const y = drops[i]! * FONT;
      ctx.fillStyle = Math.random() > 0.975 ? "#d6ffe8" : "#2bff88"; // occasional bright leading glyph
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0]!, i * FONT, y);
      if (y > h && Math.random() > 0.97) drops[i] = 0; else drops[i]!++;
    }
  };
  raf = requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) { last = 0; raf = requestAnimationFrame(frame); } else cancelAnimationFrame(raf);
  });
}
