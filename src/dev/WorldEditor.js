// World Editor (Dev Mode, F8): modifica o mundo. O World Inspector (F7) continua sendo
// só consulta técnica; este módulo é quem altera.
//
// Só é carregado em desenvolvimento (WorldScene o importa sob import.meta.env.DEV).
//
// As edições NÃO tocam nos dados originais do mapa: vão para uma camada independente
// (ModStore, src/scenes/worldMods.js) com IDs estáveis, salva em localStorage e
// exportável/importável por JSON. O WorldChunkManager consulta essa camada ao desenhar e
// ao montar colisões, então tudo sobrevive a descarregar/recarregar chunks e à página.
import { ModStore, ModPersistence, ids, parentOf, STORAGE_KEY, parseMods, mapVersionKey } from "../scenes/worldMods.js";
import { screenToWorld } from "./inspectorCore.js";
import {
  EditorSession, pickCandidates, locateElement, lotAssociations, describeElement
} from "./worldEditorCore.js";
import { ModeRegistry } from "./worldEditorModes.js";
import { WorldEditorPanel } from "./worldEditorPanel.js";

const COLOR = { selected: 0xffdf78, hover: 0x00e5ff, hidden: 0xff9f43, removed: 0xff4d4d, noCollision: 0xb28cff, ghost: 0x9aa6a0 };

const view = cam => ({
  scrollX: cam.roundPixels ? Math.floor(cam.scrollX) : cam.scrollX,
  scrollY: cam.roundPixels ? Math.floor(cam.scrollY) : cam.scrollY,
  zoom: cam.zoom, width: cam.width, height: cam.height
});

const defaultStorage = () => {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
};

export class WorldEditor {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.manager = scene.chunkManager;
    this.open = false;
    this.showGhosts = false;
    this.message = "";
    this.cand = []; this.candIndex = 0; this.lastClick = null;
    this.partFocus = null;
    this.hover = null;
    this._sig = ""; this._sinceHover = 0;

    this.store = options.store || new ModStore();
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.persistence = storage
      ? new ModPersistence(this.store, storage, { key: options.storageKey || STORAGE_KEY, meta: () => ({ mapVersion: this.mapVersion() }) })
      : null;
    // Carrega o que foi salvo ANTES de ligar à cena: chunks montados depois já nascem editados.
    const loaded = this.persistence?.load();
    this.session = new EditorSession(this.manager, this.store);
    this.session.onChange(() => this.refresh());
    this.modes = new ModeRegistry();

    this.panel = new WorldEditorPanel({
      onClose: () => this.setOpen(false),
      onMode: id => this.switchMode(id),
      onUndo: () => this.undo(), onRedo: () => this.redo(),
      onHide: () => this.hideSelected(), onRemove: () => this.removeSelected(),
      onRestore: () => this.restoreSelected(), onToggleCollision: () => this.toggleCollision(),
      onPartFocus: part => { this.partFocus = part; this.refresh(); },
      onSelectId: id => this.selectId(id),
      onToggleGhosts: () => { this.showGhosts = !this.showGhosts; this._sig = ""; this.refresh(); },
      onExport: () => this.exportJSON(),
      onImport: file => this.importFile(file),
      onClearAll: () => this.clearAll()
    });

    const keyboard = scene.input?.keyboard;
    if (keyboard) {
      keyboard.addCapture?.("F8");
      this.f8 = keyboard.addKey(119, false);
      this.f8.on?.("down", () => this.setOpen(!this.open));
      this.onKeyDown = this.onKeyDown.bind(this);
      keyboard.on?.("keydown", this.onKeyDown);
    }
    this.onPointerDown = this.onPointerDown.bind(this);
    scene.input?.on?.("pointerdown", this.onPointerDown);
    scene.events?.once?.("shutdown", () => this.destroy());

    this.layer = scene.add.graphics().setDepth(885);
    scene.hudCamera?.ignore?.(this.layer);

    if (loaded?.error) {
      this.message = "Alterações salvas não carregadas: " + loaded.error.message;
    } else if (loaded?.loaded && loaded.count) {
      this.message = String(loaded.count) + " modificações carregadas.";
      if (loaded.warning) this.message += " " + loaded.warning;
    }
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("editor") === "1") this.setOpen(true);
    this.refresh();
  }

  mapVersion() { return mapVersionKey(this.scene.mapData); }

  // ---------------------------------------------------------------- estado
  setOpen(open) {
    this.open = open;
    this.panel.setOpen(open);
    if (!open) { this.hover = null; this.layer.clear(); this._sig = ""; }
    this.refresh();
  }

  switchMode(id) {
    const result = this.modes.switchTo(id, this);
    this.message = result.ok ? "" : result.reason;
    this.refresh();
    return result;
  }

  get selection() { return this.cand[this.candIndex] || null; }

  // IDs que a ação atual afeta: a parte em foco ou o elemento inteiro.
  targetIds(el = this.selection) {
    if (!el || el.kind === "lot") return [];
    return this.partFocus && el.parts?.includes(this.partFocus) ? [ids.part(el.id, this.partFocus)] : [el.id];
  }

  // ----------------------------------------------------------------- ações
  hideSelected() { return this.act({ hidden: true }, "ocultar"); }
  removeSelected() { return this.act({ removed: true }, "remover"); }

  act(patch, verb) {
    const el = this.selection;
    const targets = this.targetIds(el);
    if (!targets.length) return null;
    const r = this.session.apply(targets, patch, `${verb} ${el.label.toLowerCase()}`);
    this.message = r ? "" : "Nada mudou.";
    this.refresh();
    return r;
  }

  restoreSelected() {
    const el = this.selection;
    if (!el || el.kind === "lot") return null;
    // Restaura o elemento, suas partes e os ancestrais que o estejam escondendo (ex.: muro inteiro).
    const list = new Set([el.id, ...(el.parts || []).map(p => ids.part(el.id, p))]);
    for (let p = parentOf(el.id); p; p = parentOf(p)) list.add(p);
    const withEntries = [...list].filter(id => this.store.entry(id));
    if (!withEntries.length) return null;
    const r = this.session.restore(withEntries, `restaurar ${el.label.toLowerCase()}`);
    if (r && withEntries.some(id => id !== el.id && !id.includes("#"))) this.message = "Restaurado também o elemento maior que o escondia.";
    this.refresh();
    return r;
  }

  collisionDefault(el) {
    // Comportamento original: tudo bloqueia, exceto o portão (abertura).
    return el.kind === "gate" ? false : true;
  }

  toggleCollision() {
    const el = this.selection;
    if (!el || el.kind === "lot") return null;
    const original = this.collisionDefault(el);
    const current = this.store.collisionEnabled(el.id, original);
    const next = !current;
    const eff = this.store.effective(el.id);
    const natural = eff.removed ? false : original; // o que valeria sem override
    const r = this.session.apply([el.id], { collision: next === natural ? null : next }, `colisão ${next ? "ligada" : "desligada"}`);
    this.refresh();
    return r;
  }

  undo() { const c = this.session.undo(); this.message = c ? `Desfeito: ${c.label}` : "Nada para desfazer."; this.refresh(); return c; }
  redo() { const c = this.session.redo(); this.message = c ? `Refeito: ${c.label}` : "Nada para refazer."; this.refresh(); return c; }

  clearAll() {
    const n = this.session.clearAll();
    this.message = n ? `${n} modificações restauradas (Ctrl+Z desfaz).` : "";
    this.refresh();
  }

  exportJSON() {
    const text = JSON.stringify(this.store.toJSON({ mapVersion: this.mapVersion() }), null, 2);
    if (typeof document === "undefined") return text;
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aracatexas-world-mods-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.message = "Exportado.";
    this.refresh();
    return text;
  }

  async importFile(file) {
    try {
      const source = await file.text();
      const parsed = parseMods(source, { expectedMapVersion: this.mapVersion() });
      const n = this.session.replaceAll(source, {
        label: "importar JSON",
        expectedMapVersion: this.mapVersion()
      });
      this.message = "Importado: " + this.store.totalCount + " itens (" + n + " alterações no mapa). Ctrl+Z desfaz.";
      if (parsed.mapVersion == null && this.mapVersion() != null) {
        this.message += " Atenção: o arquivo não informa a versão do mapa.";
      }
    } catch (error) {
      this.message = `Importação recusada: ${error.message}`; // nada foi alterado
    }
    this.refresh();
  }

  // ----------------------------------------------------------------- seleção
  selectAt(world) {
    const cands = pickCandidates(this.manager, world);
    const same = this.lastClick && Math.hypot(world.x - this.lastClick.x, world.y - this.lastClick.y) < 6 &&
      cands.length && this.cand.length && cands[0].id === this.cand[0].id;
    this.candIndex = same ? (this.candIndex + 1) % cands.length : 0;
    this.cand = cands;
    this.lastClick = world;
    this.partFocus = null;
    this.refresh();
    return this.selection;
  }

  selectId(id) {
    const el = locateElement(this.manager, id);
    if (!el) { this.message = "Elemento fora dos chunks carregados."; this.refresh(); return null; }
    this.cand = [el]; this.candIndex = 0; this.partFocus = null; this.lastClick = null;
    this.refresh();
    return el;
  }

  cycle() {
    if (this.cand.length > 1) { this.candIndex = (this.candIndex + 1) % this.cand.length; this.partFocus = null; this.refresh(); }
  }

  // ----------------------------------------------------------------- entrada
  onKeyDown(event) {
    if (!this.open || event.altKey || event.metaKey) return;
    if (event.ctrlKey) {
      if (event.code === "KeyZ" && !event.shiftKey) { event.preventDefault(); this.undo(); }
      else if (event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey)) { event.preventDefault(); this.redo(); }
      return;
    }
    if (event.repeat) return;
    if (this.modes.active.onKeyDown(this, event)) return;
    switch (event.code) {
      case "KeyH": this.hideSelected(); break;
      case "Delete": case "Backspace": event.preventDefault?.(); this.removeSelected(); break;
      case "KeyU": this.restoreSelected(); break;
      case "KeyT": this.toggleCollision(); break;
      case "KeyV": this.showGhosts = !this.showGhosts; this._sig = ""; this.refresh(); break;
      case "Tab": event.preventDefault?.(); this.cycle(); break;
      case "Escape": this.cand = []; this.candIndex = 0; this.partFocus = null; this.refresh(); break;
      default: break;
    }
  }

  onPointerDown(pointer, over) {
    if (!this.open || !pointer.leftButtonDown?.()) return;
    if (over?.length) return;
    if (this.scene.mapOverlay?.visible) return;
    const world = screenToWorld(view(this.scene.cameras.main), pointer.x, pointer.y);
    this.modes.active.onPointerDown(this, world, pointer);
  }

  // ------------------------------------------------------------------ painel
  buildState() {
    const sel = this.selection;
    const stateOf = id => { const e = this.store.effective(id); return e.removed ? "removido" : e.hidden ? "oculto" : "visível"; };
    let selection = null;
    if (sel) {
      const eff = this.store.effective(sel.id);
      const original = this.collisionDefault(sel);
      selection = {
        el: sel, rows: describeElement(this.manager, this.store, sel, this.partFocus),
        editable: sel.kind !== "lot",
        state: eff, modified: Boolean(this.store.entry(sel.id)) || (sel.parts || []).some(p => this.store.entry(ids.part(sel.id, p))) ||
          [...[parentOf(sel.id)].filter(Boolean)].some(p => this.store.entry(p)),
        collisionOn: this.store.collisionEnabled(sel.id, original),
        parts: sel.parts || [], partFocus: this.partFocus,
        candidates: this.cand.length, index: this.candIndex, assoc: null
      };
      if (sel.kind === "lot") {
        const a = lotAssociations(this.manager, sel);
        const map = (list, label) => list.map(e => ({ id: e.id, label: label(e), state: stateOf(e.id) }));
        selection.assoc = {
          buildings: map(a.buildings, e => `${e.label} ${String(e.feature?.id ?? "").slice(-6)}`),
          trees: map(a.trees, e => `Árvore ${e.id.slice(-6)}`),
          wall: a.wall ? map([a.wall], () => `Muro (${a.wallPieces.length} trechos)`) : [],
          gate: a.gate ? map([a.gate], () => "Portão") : []
        };
      }
    }
    const hiddenList = this.store.ids().map(id => {
      const e = this.store.entry(id);
      return { id, label: e.removed ? "removido" : e.hidden ? "oculto" : e.collision === false ? "sem colisão" : "colisão ligada" };
    });
    const top = this.session.history.undoStack.at(-1), redoTop = this.session.history.redoStack.at(-1);
    return {
      open: this.open, modeId: this.modes.activeId, modes: this.modes.list().map(m => ({ id: m.id, label: m.label, enabled: m.enabled, reason: m.reason })),
      selection, canUndo: this.session.history.canUndo, canRedo: this.session.history.canRedo,
      undoLabel: top?.label, redoLabel: redoTop?.label, showGhosts: this.showGhosts,
      modCount: this.store.totalCount, hiddenList, message: this.message
    };
  }

  refresh() {
    this._sig = "";
    if (this.open) this.panel.render(this.buildState());
  }

  // -------------------------------------------------------------- overlay
  update(delta = 16) {
    if (!this.open) return;
    const cam = this.scene.cameras.main;
    this._sinceHover += delta;
    let hoverId = this.hover?.id ?? null;
    if (this._sinceHover > 120) {
      this._sinceHover = 0;
      const p = this.scene.input.activePointer;
      const hit = pickCandidates(this.manager, screenToWorld(view(cam), p.x, p.y), { includeLots: false })[0] || null;
      this.hover = hit; hoverId = hit?.id ?? null;
    }
    const sel = this.selection;
    const sig = `${sel?.id}|${this.candIndex}|${hoverId}|${cam.zoom.toFixed(2)}|${this.store.revision}|${this.showGhosts}|${this.partFocus}`;
    if (sig === this._sig) return;
    this._sig = sig;
    this.drawOverlay(cam.zoom);
  }

  drawShape(g, el, color, width, alpha = 1) {
    const geo = el.geometry;
    if (!geo) return;
    g.lineStyle(width, color, alpha);
    if (geo.type === "ring") g.strokePoints(geo.ring.map(p => ({ x: p.x, y: p.y })), true, true);
    else if (geo.type === "segment") { g.lineStyle(width * 2, color, alpha); g.lineBetween(geo.a.x, geo.a.y, geo.b.x, geo.b.y); }
    else if (geo.type === "circle") g.strokeCircle(geo.x, geo.y, geo.r);
  }

  drawOverlay(zoom) {
    const g = this.layer;
    g.clear();
    const w = Math.max(1, 2 / zoom);
    if (this.showGhosts) {
      for (const chunk of this.manager.loaded.values()) {
        for (const h of chunk.record?.editorHidden || []) {
          const el = { geometry: h.kind === "tree" ? { type: "circle", x: h.point.x, y: h.point.y - 4, r: h.radius }
            : h.kind === "wall" ? { type: "segment", a: h.segment.a, b: h.segment.b } : { type: "ring", ring: h.ring } };
          this.drawShape(g, el, this.store.effective(h.id).removed ? COLOR.removed : COLOR.hidden, w, 0.8);
        }
      }
    }
    if (this.hover && this.hover.id !== this.selection?.id) this.drawShape(g, this.hover, COLOR.hover, w, 0.8);
    const sel = this.selection;
    if (sel) {
      const eff = this.store.effective(sel.id);
      const color = eff.removed ? COLOR.removed : eff.hidden ? COLOR.hidden : COLOR.selected;
      this.drawShape(g, sel, color, w * 1.6, 1);
      if (sel.kind !== "lot" && !this.store.collisionEnabled(sel.id, this.collisionDefault(sel))) {
        this.drawShape(g, sel, COLOR.noCollision, w, 0.9);
      }
    }
  }

  destroy() {
    this.scene.input?.keyboard?.off?.("keydown", this.onKeyDown);
    this.scene.input?.off?.("pointerdown", this.onPointerDown);
    this.persistence?.dispose();
    this.session?.dispose();
    this.panel?.destroy();
    this.layer?.destroy?.();
  }
}
