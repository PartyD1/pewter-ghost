/**
 * CSS for the ghost's DOM pieces (canvas caption, edge arrow, dev overlay).
 * Injected once; style.css belongs to the editor module.
 *
 * Old Pewter Platformer look (legacy/chatbox.css): the caption and arrow are
 * small pills of the old panel's glass (.pt-chatbox background
 * rgba(6,6,16,.78)) in the old panel font (--pt-font) with the old tab radius
 * (6px); their dashed white border is the plan's ghost mark (not colour
 * alone). The dev overlay (?dev=1 only) sits under the old minimap
 * (canvas y 10-58), at top 68px (NEW).
 */
const ID = "pg-ghost-style";

const CSS = `
.pg-ghost-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 4; overflow: hidden; }
.pg-ghost-caption {
  position: absolute; left: 0; top: 0; transform: translate(-50%, -100%);
  font: 600 12px/1.2 var(--pt-font, "Space Grotesk", system-ui, sans-serif); letter-spacing: 0.01em;
  color: #ffffff; background: rgba(6, 6, 16, 0.78); border: 1px dashed rgba(255, 255, 255, 0.7);
  border-radius: 6px; padding: 2px 6px; white-space: nowrap; pointer-events: none;
  opacity: 0; transition: opacity 120ms linear;
}
.pg-ghost-caption.pg-in { opacity: 1; }
.pg-ghost-caption.pg-out { opacity: 0; transition-duration: 600ms; }
.pg-ghost-caption.pg-fix { border-color: rgba(255, 120, 130, 0.9); }
.pg-ghost-arrow {
  position: absolute; left: 0; top: 0; width: 28px; height: 28px; margin: -14px 0 0 -14px;
  display: flex; align-items: center; justify-content: center; padding: 0;
  font: 700 14px/1 var(--pt-font, "Space Grotesk", system-ui, sans-serif); color: #ffffff; cursor: pointer; pointer-events: auto;
  background: rgba(6, 6, 16, 0.78); border: 1px dashed rgba(255, 255, 255, 0.85); border-radius: 50%;
  opacity: 0; transition: opacity 120ms linear;
}
.pg-ghost-arrow.pg-in { opacity: 0.9; }
.pg-ghost-arrow[hidden], .pg-ghost-caption[hidden], .pg-ghost-dev[hidden] { display: none; }
.pg-ghost-arrow:hover, .pg-ghost-arrow:focus-visible { opacity: 1; outline: 2px solid #7c5cfa; outline-offset: 1px; }
.pg-ghost-arrow span { display: block; }
.pg-ghost-arrow small { position: absolute; top: 100%; margin-top: 2px; font: 600 10px/1 var(--pt-font, "Space Grotesk", system-ui, sans-serif); color: #fff; text-shadow: 0 0 3px #000; white-space: nowrap; }
.pg-ghost-dev {
  position: absolute; left: 10px; top: 68px; z-index: 6; max-width: 360px; pointer-events: none;
  font: 11px/1.35 "JetBrains Mono", "Fira Code", "Consolas", monospace; color: #e8e8ff;
  background: rgba(6, 6, 16, 0.78); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap;
}
@media (prefers-reduced-motion: reduce) {
  .pg-ghost-caption, .pg-ghost-arrow { transition: none; }
}
`;

export function injectGhostStyles(doc: Document = document): void {
  if (doc.getElementById(ID)) return;
  const el = doc.createElement("style");
  el.id = ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

/** True when the person asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
