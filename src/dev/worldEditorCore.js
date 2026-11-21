// World Editor (Dev Mode): lógica pura, sem Phaser e sem DOM, testável em Node.
//
// Separado do World Inspector (consulta técnica): aqui ficam seleção de elementos
// individuais, histórico (desfazer/refazer) e a ponte com a camada de modificações
// (src/scenes/worldMods.js). Nada aqui altera os dados originais do mapa.
import { pointInPolygon, polygonCentroid } from "../utils/geometry.js";
import { ids, kindOf, parentOf } from "../scenes/worldMods.js";
import { PPM, chunkCoordsAt, worldToMeters } from "./inspectorCore.js";

const inBounds = (b, p, pad = 0) =>
  p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

const boundsOfPoints = (points, pad = 0) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
};

const unionBounds = list => {
  const valid = list.filter(Boolean);
  if (!valid.length) return null;
  return {
    minX: Math.min(...valid.map(b => b.minX)), minY: Math.min(...valid.map(b => b.minY)),
    maxX: Math.max(...valid.map(b => b.maxX)), maxY: Math.max(...valid.map(b => b.maxY))
  };
};

const loadedRecords = manager => {
  const out = [];
  for (const chunk of manager.loaded.values()) {
    if (chunk.state === "loaded" && chunk.record) out.push({ chunk, record: chunk.record });
  }
  return out;
};

// -------------------------------------------------------- elementos editáveis
// Elemento = { id, kind, label, bounds, geometry, partsSeparable, chunkKey, hiddenGhost }
// geometry (para o overlay): { type: "ring"|"segment"|"circle", ... }

function buildingElement(item, polygonIndex, chunkKey, ghost = false) {
  const ring = item.polygons[polygonIndex][0];
  return {
    id: ids.building(item.feature.id, polygonIndex), kind: "building",
    label: `Construção (${item.feature.building_type || "casa"})`,
    bounds: boundsOfPoints(ring, 8), geometry: { type: "ring", ring },
    // Em v4preview/fallback/não residenciais o telhado é um objeto à parte; na composição
    // residencial V2 (sprite único) estrutura e telhado saem juntos.
    parts: ["structure", "roof"], chunkKey, ghost, feature: item.feature
  };
}

function wallElements(manager, lotKey, plan) {
  const out = [];
  for (const seg of plan.collisions) {
    if (seg.piece === undefined || seg.piece === "gate") continue;
    out.push({
      id: ids.wallPiece(lotKey, seg.piece), kind: "wall", label: "Trecho de muro",
      bounds: boundsOfPoints([seg.a, seg.b], 28), geometry: { type: "segment", a: seg.a, b: seg.b },
      parts: [], lotKey
    });
  }
  return out;
}

function gateElement(lotKey, plan) {
  if (!plan.gate || !plan.gateSegment) return null;
  return {
    id: ids.gate(lotKey), kind: "gate", label: "Portão (abertura)",
    bounds: boundsOfPoints([plan.gateSegment.a, plan.gateSegment.b], 28),
    geometry: { type: "segment", a: plan.gateSegment.a, b: plan.gateSegment.b }, parts: [], lotKey
  };
}

// Todos os elementos que cobrem o ponto, do mais "específico" para o mais geral.
// Inclui os ocultos/removidos (fantasmas) para poderem ser selecionados e restaurados.
export function pickCandidates(manager, p, { wallTolerance = 7, includeLots = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = el => { if (el && !seen.has(el.id)) { seen.add(el.id); out.push(el); } };
  const records = loadedRecords(manager);

  // construções
  for (const { chunk, record } of records) {
    if (manager.showBuildings === false) continue; // sem construções desenhadas, não há o que editar
    for (const item of record.buildings) {
      if (!inBounds(item.bounds, p)) continue;
      item.polygons.forEach((poly, i) => {
        if (poly[0]?.length >= 3 && pointInPolygon(p, poly)) add(buildingElement(item, i, chunk.key));
      });
    }
  }
  // portões e trechos de muro (usa os planos já calculados; não gera nada novo)
  for (const [lotKey, plan] of manager.lotWallPlans || []) {
    if (!plan || !inBounds(plan.bbox, p, wallTolerance + 28)) continue;
    const gate = gateElement(lotKey, plan);
    if (gate && segDist(p, plan.gateSegment.a, plan.gateSegment.b) <= wallTolerance) add(gate);
    let best = null;
    for (const el of wallElements(manager, lotKey, plan)) {
      const d = segDist(p, el.geometry.a, el.geometry.b);
      if (d <= wallTolerance && (!best || d < best.d)) best = { el, d };
    }
    if (best) add(best.el);
  }
  // árvores (visíveis e fantasmas)
  for (const { chunk, record } of records) {
    for (const tree of record.trees) {
      if (Math.hypot(p.x - tree.point.x, p.y - tree.point.y) <= tree.radius) add(treeElement(tree, chunk.key));
    }
    for (const h of record.editorHidden) {
      if (h.kind === "tree" && Math.hypot(p.x - h.point.x, p.y - h.point.y) <= h.radius) {
        add({ ...treeElement({ feature: { id: h.id.slice(5) }, point: h.point, radius: h.radius }, chunk.key), ghost: true });
      }
      if (h.kind === "wall" && h.segment && segDist(p, h.segment.a, h.segment.b) <= wallTolerance) {
        add({ id: h.id, kind: "wall", label: "Trecho de muro", ghost: true,
          bounds: boundsOfPoints([h.segment.a, h.segment.b], 28),
          geometry: { type: "segment", a: h.segment.a, b: h.segment.b }, parts: [], lotKey: h.id.slice(5).split("#")[0] });
      }
      if (h.kind === "building" && h.ring && pointInPolygon(p, [h.ring])) {
        // construção totalmente oculta não está mais em record.buildings visíveis? (continua em
        // record.buildings; só entra aqui como fantasma se já não foi adicionada acima)
        const [, fid, poly] = h.id.split(":");
        const item = record.buildings.find(b => String(b.feature.id) === fid);
        if (item) add({ ...buildingElement(item, Number(poly), chunk.key), ghost: true });
      }
    }
  }
  if (includeLots) {
    for (const { chunk, record } of records) {
      for (const item of record.lots) {
        if (!inBounds(item.bounds, p)) continue;
        item.polygons.forEach((poly, i) => {
          if (!pointInPolygon(p, poly)) return;
          add({
            id: ids.lot(item.feature.id, i), kind: "lot", label: "Lote", chunkKey: chunk.key,
            bounds: boundsOfPoints(poly[0], 8), geometry: { type: "ring", ring: poly[0] },
            parts: [], feature: item.feature, polygonIndex: i
          });
        });
      }
    }
  }
  return out;
}

function treeElement(tree, chunkKey) {
  return {
    id: ids.tree(tree.feature.id), kind: "tree", label: "Árvore", chunkKey,
    bounds: { minX: tree.point.x - tree.radius - 8, minY: tree.point.y - tree.radius - 16,
      maxX: tree.point.x + tree.radius + 8, maxY: tree.point.y + 16 },
    geometry: { type: "circle", x: tree.point.x, y: tree.point.y - 4, r: tree.radius },
    parts: [], feature: tree.feature, point: tree.point, radius: tree.radius
  };
}

// Resolve um ID em elemento (para desfazer/importar/restaurar). null se o elemento não
// está em nenhum chunk carregado — nesse caso o chamador reconstrói todos os chunks.
export function locateElement(manager, id) {
  const kind = kindOf(id);
  const base = parentOf(id) || id;
  const records = loadedRecords(manager);
  if (kind === "tree") {
    const fid = base.slice(5);
    for (const { chunk, record } of records) {
      const t = record.trees.find(x => String(x.feature.id) === fid);
      if (t) return treeElement(t, chunk.key);
      const h = record.editorHidden.find(x => x.id === base);
      if (h) return treeElement({ feature: { id: fid }, point: h.point, radius: h.radius }, chunk.key);
    }
    return null;
  }
  if (kind === "building") {
    const [, fid, poly] = base.split(":");
    for (const { chunk, record } of records) {
      const item = record.buildings.find(b => String(b.feature.id) === fid);
      if (item && item.polygons[Number(poly)]) return buildingElement(item, Number(poly), chunk.key);
    }
    return null;
  }
  if (kind === "wall" || kind === "gate" || kind === "lot") {
    const lotKey = base.split(":").slice(1).join(":");
    const plan = manager.lotWallPlans?.get(lotKey);
    if (kind === "lot") {
      const [fid, poly] = lotKey.split(":");
      for (const { chunk, record } of records) {
        const item = record.lots.find(l => String(l.feature.id) === fid);
        if (item && item.polygons[Number(poly)]) {
          return { id: base, kind: "lot", label: "Lote", chunkKey: chunk.key, parts: [],
            bounds: boundsOfPoints(item.polygons[Number(poly)][0], 8),
            geometry: { type: "ring", ring: item.polygons[Number(poly)][0] }, feature: item.feature, polygonIndex: Number(poly) };
        }
      }
      return null;
    }
    if (!plan) return null;
    const lotBounds = boundsOfPoints([...plan.rings.outer, plan.anchor], 28);
    if (kind === "gate") return { ...gateElement(lotKey, plan), bounds: lotBounds };
    const piece = id.includes("#") ? id.split("#")[1] : null;
    if (piece) {
      const seg = plan.collisions.find(c => c.piece === piece);
      if (seg) return { ...wallElements(manager, lotKey, { collisions: [seg] })[0], bounds: lotBounds };
    }
    return { id: base, kind: "wall", label: "Muro do lote", lotKey, parts: [], bounds: lotBounds,
      geometry: { type: "ring", ring: plan.rings.center } };
  }
  return null;
}

// Elementos associados a um lote: construções e árvores dentro dele, o muro e o portão.
export function lotAssociations(manager, lotElement) {
  const lotKey = lotElement.id.slice(4); // lot:<id>:<poly> -> "<id>:<poly>"
  const polyIndex = lotElement.polygonIndex ?? 0;
  const ring = lotElement.geometry?.ring || [];
  const out = { buildings: [], trees: [], wall: null, gate: null, wallPieces: [] };
  const records = loadedRecords(manager);
  for (const { chunk, record } of records) {
    for (const item of record.buildings) {
      const lb = lotElement.bounds;
      if (item.bounds.maxX < lb.minX || item.bounds.minX > lb.maxX ||
          item.bounds.maxY < lb.minY || item.bounds.minY > lb.maxY) continue;
      item.polygons.forEach((poly, i) => {
        if (poly[0]?.length >= 3 && pointInPolygon(polygonCentroid(poly[0]), [ring])) {
          out.buildings.push(buildingElement(item, i, chunk.key));
        }
      });
    }
    for (const t of [...record.trees, ...record.editorHidden.filter(h => h.kind === "tree").map(h => ({ feature: { id: h.id.slice(5) }, point: h.point, radius: h.radius }))]) {
      if (pointInPolygon(t.point, [ring])) out.trees.push(treeElement(t, chunk.key));
    }
  }
  const plan = manager.lotWallPlans?.get(`${lotKey.split(":")[0]}:${polyIndex}`);
  if (plan) {
    const key = `${lotKey.split(":")[0]}:${polyIndex}`;
    out.wall = { id: ids.wall(key), kind: "wall", label: "Muro do lote", lotKey: key, parts: [], bounds: lotElement.bounds,
      geometry: { type: "ring", ring: plan.rings.center } };
    out.wallPieces = wallElements(manager, key, plan);
    out.gate = gateElement(key, plan);
  }
  return out;
}

// ------------------------------------------------------------------ descrição
const STATE_LABEL = e => (e.removed ? "removido" : e.hidden ? "oculto" : "visível");

export function describeElement(manager, store, el, partFocus = null) {
  if (!el) return [];
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== "") rows.push([k, v]); };
  const eff = store.effective(el.id);
  add("tipo", el.label);
  add("id", el.id);
  add("estado", STATE_LABEL(eff));
  if (el.parts?.length) {
    for (const part of el.parts) {
      add(`parte: ${part === "structure" ? "estrutura" : "telhado"}`, STATE_LABEL(store.effective(ids.part(el.id, part))));
    }
  }
  if (el.kind !== "lot") {
    const original = el.kind === "gate" ? false : true;
    const on = store.collisionEnabled(el.id, original);
    const explicit = eff.collision !== undefined;
    add("colisão", `${on ? "ativa" : "desativada"}${explicit ? " (editada)" : ""}`);
  }
  if (el.bounds) {
    add("caixa", `${((el.bounds.maxX - el.bounds.minX) / PPM).toFixed(1)} x ${((el.bounds.maxY - el.bounds.minY) / PPM).toFixed(1)} m`);
    const m = worldToMeters({ x: (el.bounds.minX + el.bounds.maxX) / 2, y: (el.bounds.minY + el.bounds.maxY) / 2 });
    add("centro", `x ${m.x.toFixed(1)}  y ${m.y.toFixed(1)} m`);
    add("chunk", el.chunkKey || chunkCoordsAt((el.bounds.minX + el.bounds.maxX) / 2, (el.bounds.minY + el.bounds.maxY) / 2, manager.chunkSize).key);
  }
  if (el.feature) {
    for (const key of ["zone", "area_m2", "building_type", "name"]) if (el.feature[key] !== undefined) add(key, String(el.feature[key]));
  }
  return rows;
}

// ------------------------------------------------------------------ histórico
export class EditHistory {
  constructor(limit = 200) { this.undoStack = []; this.redoStack = []; this.limit = limit; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  push(command) {
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0; // uma edição nova invalida o "refazer"
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}

// ------------------------------------------------------------------- sessão
// Liga store + histórico + chunk manager. Toda mudança no store (editar, desfazer,
// importar, restaurar) reconstrói só os chunks afetados, atomicamente (visual + colisão).
const cloneAdded = items => JSON.parse(JSON.stringify(items || []));
const sameAdded = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

export class EditorSession {
  constructor(manager, store, { historyLimit = 200 } = {}) {
    this.manager = manager;
    this.store = store;
    this.history = new EditHistory(historyLimit);
    this.listeners = new Set();
    this.suspendRebuild = false;
    this._unsub = store.onChange(changes => this.onStoreChange(changes));
    manager.setWorldMods(store, { rebuild: store.size > 0 });
  }

  dispose() { this._unsub?.(); this.manager.setWorldMods(null, { rebuild: this.store.size > 0 }); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  onStoreChange(changes) {
    if (!this.suspendRebuild) this.rebuildFor(changes.map(c => c.id));
    for (const fn of this.listeners) fn(changes);
  }

  rebuildFor(idList, extraBounds = []) {
    const boundsList = [...extraBounds];
    let unknown = false;
    for (const id of idList) {
      const el = locateElement(this.manager, id);
      if (el?.bounds) boundsList.push(el.bounds); else unknown = true;
    }
    // Elemento fora dos chunks carregados não precisa de reconstrução imediata: o chunk
    // consultará a camada quando for (re)carregado. Só reconstrói tudo se for um ID
    // desconhecido E a mudança afetar algum chunk carregado (importações grandes).
    if (unknown && idList.length > 24) return this.manager.rebuildChunks(null);
    return boundsList.length ? this.manager.rebuildChunks(boundsList) : [];
  }

  // Aplica `patch` a vários IDs como UM passo de histórico.
  apply(idList, patch, label = "edição") {
    const before = {}, after = {};
    const changes = [];
    this.suspendRebuild = true;
    try {
      for (const id of idList) {
        const change = this.store.set(id, patch, { silent: true });
        if (!change) continue;
        before[id] = change.before; after[id] = change.after;
        changes.push(change);
      }
    } finally { this.suspendRebuild = false; }
    if (!changes.length) return null;
    this.history.push({ label, before, after });
    this.store.emit(changes);
    return { label, changes };
  }

  restore(idList, label = "restaurar") { return this.apply(idList, null, label); }

  applyHistoryState(cmd, side) {
    const entries = side === "before" ? cmd.before : cmd.after;
    const added = side === "before" ? cmd.beforeAdded : cmd.afterAdded;
    const addedChanged = Array.isArray(added) && !sameAdded(this.store.added, added);
    if (Array.isArray(added)) this.store.added = cloneAdded(added);
    const changes = this.store.setExact(entries, { silent: true });
    if (changes.length || addedChanged) {
      if (!changes.length) this.store.revision++;
      this.store.emit(changes);
    }
  }

  undo() {
    const cmd = this.history.undoStack.pop();
    if (!cmd) return null;
    this.applyHistoryState(cmd, "before");
    this.history.redoStack.push(cmd);
    return cmd;
  }

  redo() {
    const cmd = this.history.redoStack.pop();
    if (!cmd) return null;
    this.applyHistoryState(cmd, "after");
    this.history.undoStack.push(cmd);
    return cmd;
  }

  // Importar/restaurar tudo: um passo desfazível.
  replaceAll(payload, { merge = false, label = "importar", expectedMapVersion = null } = {}) {
    const before = Object.fromEntries(this.store.ids().map(id => [id, this.store.entry(id)]));
    const beforeAdded = cloneAdded(this.store.added);
    this.suspendRebuild = true;
    let changes;
    try {
      changes = this.store.load(payload, { silent: true, merge, expectedMapVersion });
    } finally { this.suspendRebuild = false; }
    const after = Object.fromEntries(this.store.ids().map(id => [id, this.store.entry(id)]));
    for (const id of Object.keys(before)) if (!(id in after)) after[id] = null;
    for (const id of Object.keys(after)) if (!(id in before)) before[id] = null;
    const afterAdded = cloneAdded(this.store.added);
    const addedChanged = !sameAdded(beforeAdded, afterAdded);
    if (changes.length || addedChanged) {
      this.history.push({ label, before, after, beforeAdded, afterAdded });
      this.store.emit(changes);
    }
    return changes.length + (addedChanged ? Math.max(beforeAdded.length, afterAdded.length) : 0);
  }

  clearAll(label = "restaurar tudo") {
    const before = Object.fromEntries(this.store.ids().map(id => [id, this.store.entry(id)]));
    const beforeAdded = cloneAdded(this.store.added);
    if (!Object.keys(before).length && !beforeAdded.length) return 0;
    const after = Object.fromEntries(Object.keys(before).map(id => [id, null]));
    this.suspendRebuild = true;
    let changes;
    try { changes = this.store.clear({ silent: true }); } finally { this.suspendRebuild = false; }
    const afterAdded = cloneAdded(this.store.added);
    this.history.push({ label, before, after, beforeAdded, afterAdded });
    this.store.emit(changes);
    return changes.length + beforeAdded.length;
  }
}

export { unionBounds, boundsOfPoints };
