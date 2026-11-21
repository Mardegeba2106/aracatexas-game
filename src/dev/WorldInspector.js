// World Inspector (Dev Mode): inspeciona o mundo durante a execução do jogo.
//
// Só é carregado em desenvolvimento (WorldScene o importa sob import.meta.env.DEV),
// então o build de produção não contém este arquivo. Funciona junto com a câmera
// livre (F6), porque tudo é calculado a partir da câmera principal.
//
// Somente lê dados que o jogo já tem (chunkManager.loaded, record.lots, colisões...).
// Não altera o mapa, não altera colisões e não força o carregamento de chunks.
import {
  PPM, screenToWorld, worldToScreen, worldToMeters, distanceMeters, metersToLonLat,
  gridStepMeters, viewBounds, boundsIntersect, chunkCoordsAt, describeChunk,
  pickLot, pickObject, describeObject
} from "./inspectorCore.js";

const COLOR = {
  lot: 0x00e5ff, selected: 0xffdf78, building: 0xff4d4d, wall: 0xff9f43,
  grid: 0xffffff, axis: 0xffdf78, measure: 0xff5cf4,
  chunkReady: 0x6fd36f, chunkLoading: 0xffd24d, chunkOther: 0x8aa0a0
};
const PANEL_W = 300;
const TEXT = {
  fontFamily: "Consolas, monospace", fontSize: "10px", color: "#d8e6c5",
  lineSpacing: 1, wordWrap: { width: PANEL_W - 18 }
};

// Enquadramento exatamente como o Phaser desenha: com roundPixels o scroll sofre floor.
const view = cam => ({
  scrollX: cam.roundPixels ? Math.floor(cam.scrollX) : cam.scrollX,
  scrollY: cam.roundPixels ? Math.floor(cam.scrollY) : cam.scrollY,
  zoom: cam.zoom, width: cam.width, height: cam.height
});

export class WorldInspector {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.cfg = { refreshMs: 120, ...options };
    this.open = false;
    this.toggles = { lot: true, grid: false, collisions: false, chunks: false };
    this.measure = { active: false, points: [] };
    this.hover = null;
    this.selected = null;
    this.cursor = { sx: 0, sy: 0, world: { x: 0, y: 0 }, inside: false };
    this._prev = {};
    this._sinceRefresh = 0;
    this._layerSig = "";
    this.labels = [];

    const keyboard = scene.input?.keyboard;
    this.f7 = null;
    if (keyboard) {
      keyboard.addCapture?.("F7"); // F7 abre "navegação por cursor" em alguns navegadores
      this.f7 = keyboard.addKey(118, false);
      // Por evento da tecla (nao por polling): toque curto em FPS baixo ainda conta.
      this.f7Event = typeof this.f7.on === "function";
      if (this.f7Event) this.f7.on("down", () => this.setOpen(!this.open));
      this.onKeyDown = this.onKeyDown.bind(this);
      keyboard.on?.("keydown", this.onKeyDown);
    }
    this.onPointerDown = this.onPointerDown.bind(this);
    this.layout = this.layout.bind(this);
    scene.input?.on?.("pointerdown", this.onPointerDown);
    scene.scale?.on?.("resize", this.layout);
    scene.events?.once?.("shutdown", () => this.destroy());

    // Camadas desenhadas no mundo (a câmera do HUD as ignora).
    this.layer = scene.add.graphics().setDepth(880);
    this.top = scene.add.graphics().setDepth(890);
    scene.hudCamera?.ignore([this.layer, this.top]);

    this.createPanel();
    this.applyUrlPresets();
    this.layout();
    this.refreshPanel(true);
  }

  // ---------------------------------------------------------------- estado
  applyUrlPresets() {
    // ?inspector=1 abre o painel; ?inspector=grid,collisions,chunks liga camadas.
    const value = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("inspector") : null;
    if (!value) return;
    for (const token of value.split(",")) {
      if (token in this.toggles) this.toggles[token] = true;
    }
    this.setOpen(true);
  }

  setOpen(open) {
    this.open = open;
    for (const o of this.panelObjects) o.setVisible(open);
    if (!open) { this.hover = null; this.top.clear(); this.layer.clear(); this.hideLabels(0); this._layerSig = ""; this.measureLabel.setVisible(false); }
    this.layout();
    this.refreshPanel(true);
  }

  toggle(name) {
    this.toggles[name] = !this.toggles[name];
    this._layerSig = "";
    this.refreshPanel(true);
  }

  toggleMeasure() {
    this.measure.active = !this.measure.active;
    this.measure.points = [];
    this.refreshPanel(true);
  }

  // ----------------------------------------------------------------- entrada
  onKeyDown(event) {
    if (!this.open || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    switch (event.code) {
      case "KeyL": this.toggle("lot"); break;
      case "KeyG": this.toggle("grid"); break;
      case "KeyC": this.toggle("collisions"); break;
      case "KeyK": this.toggle("chunks"); break;
      case "KeyR": this.toggleMeasure(); break;
      case "Escape":
        if (this.measure.points.length) this.measure.points = [];
        else if (this.measure.active) this.measure.active = false;
        else this.selected = null;
        this.refreshPanel(true);
        break;
      default: break;
    }
  }

  overPanel(sx, sy) {
    const r = this.panelRect;
    return this.open && r && sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h;
  }

  onPointerDown(pointer, over) {
    if (!this.open || !pointer.leftButtonDown?.()) return;
    if (over?.length) return;                          // minimapa, painel, botões do HUD
    if (this.scene.mapOverlay?.visible) return;        // mapa grande aberto
    if (this.overPanel(pointer.x, pointer.y)) return;
    const manager = this.scene.chunkManager;
    if (!manager) return;
    const world = screenToWorld(view(this.scene.cameras.main), pointer.x, pointer.y);

    if (this.measure.active) {
      // 1º clique = A, 2º = B, 3º recomeça a medição.
      if (this.measure.points.length >= 2) this.measure.points = [];
      this.measure.points.push(world);
    } else {
      this.selected = pickObject(manager, world); // clicar no vazio limpa a seleção
    }
    this.refreshPanel(true);
  }

  edge(name, down) {
    const was = this._prev[name] === true;
    this._prev[name] = down;
    return down && !was;
  }

  // ------------------------------------------------------------------ update
  update(deltaMs) {
    if (!this.f7Event && this.edge("F7", this.f7?.isDown === true)) this.setOpen(!this.open);
    const scene = this.scene, cam = scene.cameras.main, manager = scene.chunkManager;
    if (!manager) return;

    const pointer = scene.input.activePointer;
    const over = scene.input.manager?.isOver !== false;
    const inside = over && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= cam.width && pointer.y <= cam.height;
    this.cursor = { sx: pointer.x, sy: pointer.y, inside, world: screenToWorld(view(cam), pointer.x, pointer.y) };

    const free = !this.overPanel(pointer.x, pointer.y);
    this.hover = this.open && this.toggles.lot && inside && free ? pickLot(manager, this.cursor.world) : null;

    this.drawLayer(cam, manager);
    if (this.open) this.drawTop(cam, manager);

    this._sinceRefresh += deltaMs;
    if (this.open && this._sinceRefresh >= this.cfg.refreshMs) this.refreshPanel(true);
  }

  // ----------------------------------------------------- camadas do mundo
  drawLayer(cam, manager) {
    const scene = this.scene, t = this.toggles;
    let ready = 0;
    for (const c of manager.loaded.values()) if (c.record) ready++;
    const sig = [Math.round(cam.scrollX), Math.round(cam.scrollY), cam.zoom.toFixed(3), cam.width, cam.height,
      t.grid, t.collisions, t.chunks, manager.loaded.size, ready, scene.wallCollision?.length, this.open].join("|");
    if (sig === this._layerSig) return;
    this._layerSig = sig;

    const g = this.layer;
    g.clear();
    let labelsUsed = 0;
    if (!this.open || (!t.grid && !t.collisions && !t.chunks)) { this.hideLabels(0); return; }

    const v = view(cam), b = viewBounds(v), px = 1 / cam.zoom;
    if (t.grid) {
      const step = gridStepMeters(cam.zoom), stepPx = step * PPM;
      const k0 = Math.ceil(b.minX / stepPx), k1 = Math.floor(b.maxX / stepPx);
      for (let k = k0; k <= k1; k++) {
        const x = k * stepPx, axis = k === 0, major = k % 5 === 0;
        g.lineStyle((axis ? 2 : 1) * px, axis ? COLOR.axis : COLOR.grid, axis ? 0.7 : major ? 0.34 : 0.17);
        g.lineBetween(x, b.minY, x, b.maxY);
        const sx = worldToScreen(v, x, 0).x;
        if (sx > 340 && !(this.open && sx > this.panelRect.x - 34)) {
          this.setLabel(labelsUsed++, `${k * step}`, sx + 2, cam.height - 14);
        }
      }
      const j0 = Math.ceil(-b.maxY / stepPx), j1 = Math.floor(-b.minY / stepPx);
      for (let j = j0; j <= j1; j++) {
        const y = -j * stepPx, axis = j === 0, major = j % 5 === 0;
        g.lineStyle((axis ? 2 : 1) * px, axis ? COLOR.axis : COLOR.grid, axis ? 0.7 : major ? 0.34 : 0.17);
        g.lineBetween(b.minX, y, b.maxX, y);
        const sy = worldToScreen(v, 0, y).y;
        if (sy > 230 && sy < cam.height - 70) this.setLabel(labelsUsed++, `${j * step}`, 4, sy - 12);
      }
    }
    this.hideLabels(labelsUsed);

    if (t.chunks) {
      for (const c of manager.loaded.values()) {
        const color = c.record ? COLOR.chunkReady : c.state === "loading" ? COLOR.chunkLoading : COLOR.chunkOther;
        g.lineStyle(1.5 * px, color, 0.75);
        g.strokeRect(c.rect.minX, c.rect.minY, manager.chunkSize, manager.chunkSize);
      }
    }

    if (t.collisions) {
      for (const c of scene.buildingCollision || []) {
        if (!c.bounds || !boundsIntersect(c.bounds, b)) continue;
        g.lineStyle(1.5 * px, COLOR.building, 0.95);
        for (const ring of c.rings) g.strokePoints(ring, true, true);
      }
      for (const c of scene.wallCollision || []) {
        if (!c.bounds || !boundsIntersect(c.bounds, b)) continue;
        for (const s of c.segments) {
          g.lineStyle(c.thickness || 8, COLOR.wall, 0.4);
          g.lineBetween(s.a.x, s.a.y, s.b.x, s.b.y);
          g.lineStyle(1 * px, COLOR.wall, 0.95);
          g.lineBetween(s.a.x, s.a.y, s.b.x, s.b.y);
        }
      }
      for (const c of scene.treeCollision || []) {
        g.lineStyle(1.5 * px, COLOR.wall, 0.95);
        g.strokeCircle(c.x, c.y, c.radius);
      }
    }
  }

  drawTop(cam, manager) {
    const g = this.top, px = 1 / cam.zoom;
    g.clear();

    // chunk sob o cursor (mesmo que não esteja carregado; só desenha o contorno)
    if (this.cursor.inside) {
      const { cx, cy } = chunkCoordsAt(this.cursor.world.x, this.cursor.world.y, manager.chunkSize);
      g.lineStyle(2 * px, 0xffffff, 0.55);
      g.strokeRect(cx * manager.chunkSize, cy * manager.chunkSize, manager.chunkSize, manager.chunkSize);
    }

    const outline = (sel, color, width, fillAlpha) => {
      g.lineStyle(width * px, color, 1);
      g.fillStyle(color, fillAlpha);
      if (sel.kind === "lot" || sel.kind === "building") {
        const ring = sel.item.polygons[sel.fragmentIndex ?? sel.polygonIndex][0];
        if (fillAlpha) g.fillPoints(ring, true, true);
        g.strokePoints(ring, true, true);
      } else if (sel.kind === "road") {
        for (const line of sel.item.lines) g.strokePoints(line, false, false);
      } else if (sel.kind === "wall") {
        for (const s of sel.plan.collisions) g.lineBetween(s.a.x, s.a.y, s.b.x, s.b.y);
      } else if (sel.kind === "tree") {
        g.strokeCircle(sel.item.point.x, sel.item.point.y, sel.item.radius);
      }
    };
    if (this.hover && !(this.selected?.item === this.hover.item)) outline(this.hover, COLOR.lot, 2, 0.1);
    if (this.selected) outline(this.selected, COLOR.selected, 3, 0.12);

    // régua
    const pts = this.measure.points;
    const live = this.measure.active && pts.length === 1 && this.cursor.inside ? this.cursor.world : null;
    const a = pts[0], b = pts[1] || live;
    if (this.measure.active && a) {
      g.fillStyle(COLOR.measure, 1);
      g.fillCircle(a.x, a.y, 5 * px);
      if (b) {
        g.lineStyle(2 * px, COLOR.measure, 1);
        g.lineBetween(a.x, a.y, b.x, b.y);
        g.fillCircle(b.x, b.y, 5 * px);
        const d = distanceMeters(a, b);
        const mid = worldToScreen(view(cam), (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.measureLabel.setText(`${d.meters.toFixed(1)} m`).setPosition(mid.x, mid.y - 14).setVisible(true);
      } else this.measureLabel.setVisible(false);
    } else this.measureLabel.setVisible(false);
  }

  // ------------------------------------------------------------------ painel
  createPanel() {
    const scene = this.scene;
    const hud = o => scene.registerHud(o.setDepth(1250));
    const text = (color) => hud(scene.add.text(0, 0, "", { ...TEXT, color: color || TEXT.color }).setOrigin(0, 0));
    this.panelBg = scene.registerHud(scene.add.rectangle(0, 0, PANEL_W, 200, 0x0e1a14, 0.86)
      .setOrigin(0, 0).setDepth(1249).setInteractive());
    this.head = text("#ffdf78");
    this.cursorTxt = text();
    this.selTxt = text();
    this.rows = [
      ["lot", "Lote sob o cursor", "L"], ["grid", "Grade de coordenadas", "G"],
      ["collisions", "Exibir colisões", "C"], ["chunks", "Limites de chunks", "K"]
    ].map(([key, label, hotkey]) => {
      const row = text("#bfe3ff").setInteractive({ useHandCursor: true });
      row.on("pointerdown", () => this.toggle(key));
      row.meta = { key, label, hotkey };
      return row;
    });
    this.measureRow = text("#ffb3f7").setInteractive({ useHandCursor: true });
    this.measureRow.on("pointerdown", () => this.toggleMeasure());
    this.measureTxt = text();
    this.chunkTxt = text();
    this.measureLabel = scene.registerHud(scene.add.text(0, 0, "", {
      fontFamily: "Consolas, monospace", fontSize: "13px", color: "#ffd6fb",
      stroke: "#0e1a14", strokeThickness: 4, fontStyle: "bold"
    }).setOrigin(0.5, 1).setDepth(1260).setVisible(false));
    this.panelObjects = [this.panelBg, this.head, this.cursorTxt, this.selTxt, ...this.rows,
      this.measureRow, this.measureTxt, this.chunkTxt];
    for (const o of this.panelObjects) o.setVisible(false);
  }

  layout() {
    if (!this.panelBg) return;
    const scene = this.scene, { width, height } = scene.scale;
    // O painel fica no canto direito e desvia do minimapa, esteja ele onde estiver.
    const mm = scene.minimapBg;
    let top = 12, bottom = height - 10;
    if (mm && mm.x > width / 2) {
      const r = mm.radius || 82;
      if (mm.y < height / 2) top = mm.y + r + 10; else bottom = mm.y - r - 10;
    }
    const x = Math.max(8, width - PANEL_W - 14);
    let y = top + 6;
    // Cada bloco so aparece se couber; o que nao couber some (de baixo para cima).
    const place = (obj, gap = 7) => {
      const fits = y + obj.height <= bottom - 4;
      obj.layoutHidden = !fits;
      if (fits) { obj.setPosition(x + 9, y); y += obj.height + gap; }
    };
    place(this.head, 5);
    place(this.cursorTxt);
    for (const row of this.rows) place(row, 2);
    y += 4;
    place(this.measureRow, 3);
    place(this.measureTxt);
    place(this.selTxt);
    place(this.chunkTxt, 4);
    for (const o of this.panelObjects) {
      if (o !== this.panelBg) o.setVisible(this.open && !o.layoutHidden && !(o === this.measureTxt && !o.text));
    }
    const h = Math.max(20, Math.min(y - top, bottom - top));
    this.panelBg.setPosition(x, top).setSize(PANEL_W, h);
    this.panelRect = { x, y: top, w: PANEL_W, h };
  }

  refreshPanel(force = false) {
    this._sinceRefresh = 0;
    if (!this.open && !force) return;
    const mgr = this.scene.chunkManager, meta = this.scene.mapData?.meta;
    const w = this.cursor.world, m = worldToMeters(w);
    const ll = metersToLonLat(meta, m.x, m.y);
    const pad = (k, v) => `${String(k).padEnd(9)}${v}`;

    this.head.setText("WORLD INSPECTOR   F7 fechar");
    const player = this.scene.player;
    const pm = player ? worldToMeters(player) : null;
    this.cursorTxt.setText([
      "CURSOR",
      pad("mundo", `x ${m.x.toFixed(1)}  y ${m.y.toFixed(1)} m`),
      pad("pixel", `x ${Math.round(w.x)}  y ${Math.round(w.y)}`),
      pad("tela", `${Math.round(this.cursor.sx)}, ${Math.round(this.cursor.sy)}`),
      ll ? pad("lon/lat", `${ll.lon.toFixed(5)}, ${ll.lat.toFixed(5)}`) : null,
      pm ? pad("jogador", `x ${pm.x.toFixed(1)}  y ${pm.y.toFixed(1)} m`) : null
    ].filter(Boolean).join("\n"));

    const lines = [];
    const fmt = sel => describeObject(sel, mgr).slice(0, 11).map(([k, v]) => pad(k, v));
    if (this.selected) lines.push("SELECIONADO (clique)", ...fmt(this.selected));
    else lines.push("SELECIONADO", this.measure.active ? "(medição ativa)" : "clique em algo para inspecionar");
    if (this.hover && this.selected?.item !== this.hover.item) {
      lines.push("", "LOTE SOB O CURSOR", ...describeObject(this.hover, mgr)
        .filter(([k]) => ["id", "zona", "área", "caixa", "muro"].includes(k)).map(([k, v]) => pad(k, v)));
    }
    this.selTxt.setText(lines.join("\n"));

    for (const row of this.rows) {
      const { key, label, hotkey } = row.meta;
      row.setText(`[${this.toggles[key] ? "x" : " "}] ${label}   ${hotkey}`);
    }
    this.measureRow.setText(`[${this.measure.active ? "x" : " "}] Medidor de distância   R`);

    const mlines = [];
    const pts = this.measure.points;
    if (this.measure.active) {
      if (!pts.length) mlines.push("clique no ponto A (Esc cancela)");
      pts.forEach((p, i) => { const pm2 = worldToMeters(p); mlines.push(pad(i ? "B" : "A", `x ${pm2.x.toFixed(1)}  y ${pm2.y.toFixed(1)} m`)); });
      const b = pts[1] || (pts.length === 1 && this.cursor.inside ? w : null);
      if (pts[0] && b) {
        const d = distanceMeters(pts[0], b);
        mlines.push(pad("distância", `${d.meters.toFixed(2)} m`), pad("", `Δx ${d.dx.toFixed(1)}  Δy ${d.dy.toFixed(1)} m`));
        if (pts.length === 2) mlines.push("clique de novo para medir outra");
      }
    }
    this.measureTxt.setText(mlines.join("\n")).setVisible(this.open && mlines.length > 0);

    const { cx, cy } = chunkCoordsAt(w.x, w.y, mgr.chunkSize);
    const ci = describeChunk(mgr, cx, cy);
    const clines = ["CHUNK SOB O CURSOR", pad("id", ci.key),
      pad("canto SO", `x ${ci.originMeters.x.toFixed(0)}  y ${ci.originMeters.y.toFixed(0)} m  (${ci.sizeMeters} m)`),
      pad("estado", !ci.exists ? "fora do mapa" : ci.loaded ? `carregado (${ci.state})` : "existe, não carregado")];
    if (ci.counts) clines.push(pad("itens", Object.entries(ci.counts).map(([k, v]) => `${k} ${v}`).join(" | ")));
    clines.push(pad("global", `${ci.loadedTotal} carregados, ${ci.loadingTotal} carregando`));
    this.chunkTxt.setText(clines.join("\n"));
    this.layout();
  }

  // ------------------------------------------------------------ rótulos da grade
  setLabel(i, str, x, y) {
    let label = this.labels[i];
    if (!label) {
      label = this.scene.registerHud(this.scene.add.text(0, 0, "", {
        fontFamily: "Consolas, monospace", fontSize: "9px", color: "#cfe8ff",
        stroke: "#0e1a14", strokeThickness: 3
      }).setDepth(1240));
      this.labels[i] = label;
    }
    label.setText(str).setPosition(x, y).setVisible(true);
  }

  hideLabels(from) {
    for (let i = from; i < this.labels.length; i++) this.labels[i].setVisible(false);
  }

  destroy() {
    this.scene.input?.keyboard?.off?.("keydown", this.onKeyDown);
    this.scene.input?.off?.("pointerdown", this.onPointerDown);
    this.scene.scale?.off?.("resize", this.layout);
    for (const o of [this.layer, this.top, this.measureLabel, ...(this.panelObjects || []), ...this.labels]) o?.destroy?.();
  }
}
