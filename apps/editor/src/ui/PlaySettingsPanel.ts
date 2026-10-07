/** Play settings (G-37): sliders for gravity, run speed, jump and enemy aggression. Stored with the level. */
import { JUMP_VELOCITY_PX, GRAVITY_PX } from "../player/playerPhysics";
import { apexTiles, DEFAULT_PLAY_SETTINGS, SETTING_SPECS, type PlaySettingsStore } from "../editor/playSettings";
import { h } from "./dom";
import { openDialog } from "./Dialog";

export function openPlaySettings(store: PlaySettingsStore): void {
  openDialog(
    "Play settings",
    (body, close) => {
      const values = new Map<string, HTMLElement>();
      const inputs = new Map<string, HTMLInputElement>();
      const apex = h("p", { class: "pg-settings-apex" });
      const refresh = () => {
        const s = store.get();
        for (const spec of SETTING_SPECS) {
          values.get(spec.key)!.textContent = spec.format(s[spec.key]);
          const inp = inputs.get(spec.key)!;
          if (Number(inp.value) !== s[spec.key]) inp.value = String(s[spec.key]);
        }
        apex.textContent = `Jump height with these settings: ${apexTiles(JUMP_VELOCITY_PX, GRAVITY_PX, s).toFixed(1)} tiles (designed: ${apexTiles(JUMP_VELOCITY_PX, GRAVITY_PX, DEFAULT_PLAY_SETTINGS).toFixed(1)}).`;
      };
      const rows = SETTING_SPECS.map((spec) => {
        const id = `pg-set-${spec.key}`;
        const input = h("input", {
          id,
          type: "range",
          min: spec.min,
          max: spec.max,
          step: spec.step,
          value: store.get()[spec.key],
          "data-setting": spec.key,
          oninput: () => {
            store.set({ [spec.key]: Number(input.value) });
            refresh();
          },
        });
        const val = h("span", { class: "pg-settings-value" });
        values.set(spec.key, val);
        inputs.set(spec.key, input);
        return h("div", { class: "pg-settings-row" }, h("label", { for: id, text: spec.label }), input, val, h("small", { text: spec.hint }));
      });
      body.append(
        h("p", { class: "pg-help-lead", text: "Tune how the level plays. Settings are saved with the level and in share codes. Suggestions are checked with the default settings." }),
        ...rows,
        apex,
        h(
          "div",
          { class: "pg-dialog-actions" },
          h("button", { class: "pg-btn", type: "button", text: "Reset", onclick: () => (store.reset(), refresh()) }),
          h("button", { class: "pg-btn pg-btn-primary", type: "button", text: "Done", onclick: close }),
        ),
      );
      refresh();
    },
    { id: "pg-play-settings" },
  );
}
