/** Share code dialog (G-37): copy this level as a compact code, or open one. */
import type { LevelModel } from "../level/LevelModel";
import { encodeShareCode } from "../level/share";
import type { PlaySettings } from "../level/save";
import { h } from "./dom";
import { openDialog } from "./Dialog";

export interface ShareDeps {
  model: LevelModel;
  playSettings: () => PlaySettings | undefined;
  /** Load a decoded level; returns warnings or throws on failure. */
  open: (code: string) => Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }>;
}

export function openShareDialog(deps: ShareDeps): void {
  openDialog(
    "Share code",
    (body, close) => {
      const out = h("textarea", { class: "pg-code", readonly: true, rows: 4, "aria-label": "Share code for this level", id: "pg-share-out" });
      const status = h("p", { class: "pg-share-status", text: "Making the code…" });
      const copyBtn = h("button", { class: "pg-btn pg-btn-primary", type: "button", text: "Copy", disabled: true });
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(out.value);
          status.textContent = "Copied.";
        } catch {
          out.select();
          status.textContent = "Select the code and copy it (Ctrl+C).";
        }
      });
      encodeShareCode(deps.model, { playSettings: deps.playSettings() }).then(
        (code) => {
          out.value = code;
          status.textContent = `${code.length} characters. Anyone with Pewter Ghost can open it.`;
          copyBtn.disabled = false;
        },
        (err: unknown) => {
          status.textContent = `Could not make a code: ${(err as Error).message}`;
        },
      );

      const input = h("textarea", { class: "pg-code", rows: 3, placeholder: "Paste a code (pg1.…)", "aria-label": "Paste a share code", id: "pg-share-in" });
      const openStatus = h("p", { class: "pg-share-status" });
      const openBtn = h("button", { class: "pg-btn", type: "button", text: "Open this level" });
      openBtn.addEventListener("click", async () => {
        const code = input.value.trim();
        if (!code) {
          openStatus.textContent = "Paste a code first.";
          return;
        }
        openBtn.disabled = true;
        const r = await deps.open(code);
        openBtn.disabled = false;
        if (!r.ok) {
          openStatus.textContent = r.error;
          openStatus.classList.add("pg-error");
          return;
        }
        close();
      });

      body.append(
        h("h3", { text: "This level" }),
        out,
        status,
        h("div", { class: "pg-dialog-actions" }, copyBtn),
        h("h3", { text: "Open a level from a code" }),
        h("p", { class: "pg-help-lead", text: "Opening replaces the current level (it can't be undone, so save first if you want to keep it)." }),
        input,
        openStatus,
        h("div", { class: "pg-dialog-actions" }, openBtn),
      );
    },
    { wide: true, id: "pg-share" },
  );
}

