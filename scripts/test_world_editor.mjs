// Testa o World Editor com os dados reais do mapa e o WorldChunkManager REAL
// (só o Phaser é substituído por um stub que registra o que seria desenhado).
// Uso: node scripts/test_world_editor.mjs
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

// ---- stub do Phaser: o chunk manager importa "phaser" no topo do módulo ---------
const STUB = `
export default {
  Geom: { Point: class { constructor(x, y) { this.x = x; this.y = y; } } },
  Math: {
    Clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    Linear: (a, b, t) => a + (b - a) * t,
    Distance: { Between: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1) }
  }
};`;
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "phaser") return { url: "data:text/javascript," + ${JSON.stringify("PLACEHOLDER")}, shortCircuit: true };
  return next(spec, ctx);
}`.replace('"PLACEHOLDER"', JSON.stringify(encodeURIComponent(STUB)))));

const { default: WorldChunkManager } = await import("../src/scenes/WorldChunkManager.js");
const mods = await import("../src/scenes/worldMods.js");
const core = await import("../src/dev/worldEditorCore.js");
const modes = await import("../src/dev/worldEditorModes.js");
const inspector = await import("../src/dev/inspectorCore.js");
const { planLotWall, buildRoadSegments } = await import("../src/scenes/lotWalls.js");

const { ModStore, ModPersistence, ids, applyWallMods, parseMods, mapVersionKey, MODS_FORMAT } = mods;
const { EditorSession, pickCandidates, locateElement, lotAssociations, describeElement } = core;

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FALHOU:", m); } else console.log("ok:", m); };
const throws = (fn, m) => { try { fn(); failed++; console.log("FALHOU (não lançou):", m); } catch { console.log("ok:", m); } };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = p => JSON.parse(fs.readFileSync(path.join(root, "public", "data", p), "utf8"));
const manifest = data("world-manifest.json");
const roadIndex = data("roads-index.json");

// ---- cena falsa: objetos que só registram o que foi desenhado --------------------
function fakeObject(kind) {
  const o = { kind, depth: 0, destroyed: false, calls: [] };
  const proxy = new Proxy(o, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "destroy") return () => { target.destroyed = true; };
      if (prop === "setDepth") return d => { target.depth = d; return proxy; };
      if (prop === "createGeometryMask") return () => ({});
      return (...args) => { target.calls.push([prop, args]); return proxy; };
    }
  });
  return proxy;
}
function fakeScene() {
  const created = [];
  const mk = kind => () => { const o = fakeObject(kind); created.push(o); return o; };
  return {
    created, v4Preview: true,
    add: { graphics: mk("graphics"), tileSprite: mk("tileSprite"), image: mk("image"), text: mk("text"), rectangle: mk("rect") },
    textures: { exists: () => true },
    hudCamera: { ignore() {} }
  };
}

function loadChunk(manager, raw) {
  const chunk = manager.createChunk(raw.cx, raw.cy);
  chunk.state = "building"; chunk.buildRaw = raw; chunk.buildStage = 0;
  manager.buildQueue.push(chunk);
  for (let i = 0; i < 20 && chunk.state !== "loaded"; i++) manager.processReadyChunks();
  return chunk;
}
function makeManager({ store = null, buildings = true } = {}) {
  const scene = fakeScene();
  const m = new WorldChunkManager(scene, { chunkManifest: manifest, roads: [], roadIndex });
  m.showBuildings = buildings;       // ?buildings=1
  m.retainRaw = true;                // como em desenvolvimento
  m.maxBuildStepsPerFrame = 100; m.buildBudgetMs = 1e9;
  if (store) m.setWorldMods(store, { rebuild: false });
  return { m, scene };
}

// ---- escolhe um chunk real com construções e um lote cujo muro ele mesmo desenha ----
const files = fs.readdirSync(path.join(root, "public/data/chunks"));
let treesInData = 0;
const segs = buildRoadSegments(roadIndex);
const scored = files.map(f => {
  const raw = data(`chunks/${f}`);
  treesInData += (raw.trees || []).length;
  return { raw, score: (raw.lots || []).length + (raw.buildings || []).length * 2 };
}).sort((x, y) => y.score - x.score);
// o chunk que contém a âncora (1º vértice) do lote é quem desenha o muro inteiro
function findWallLot(manager, chunk, minPieces) {
  for (const item of chunk.record.lots) {
    for (let i = 0; i < item.polygons.length; i++) {
      const plan = manager.getLotWallPlan(item, i);
      if (!plan || plan.collisions.length < minPieces) continue;
      if (plan.collisions.some(c => c.piece === undefined)) continue;
      if (Math.floor(plan.anchor.x / 512) !== chunk.cx || Math.floor(plan.anchor.y / 512) !== chunk.cy) continue;
      return { key: `${item.feature.id}:${i}`, item, i, plan };
    }
  }
  return null;
}
let rawWalls = null, wallLot = null;
for (const { raw } of scored.slice(0, 80)) {
  const probe = makeManager();
  const chunk = loadChunk(probe.m, raw);
  const found = findWallLot(probe.m, chunk, 3);
  if (found && (found.plan.gate || !wallLot)) { rawWalls = raw; wallLot = found; if (found.plan.gate) break; }
}
const wallScore = scored.find(x => x.raw === rawWalls)?.score;
// O mapa atual NÃO tem árvores (0 em todos os chunks). Para testar o editor nelas,
// injetamos árvores sintéticas numa CÓPIA do chunk real (os arquivos de dados não são tocados).
const rawTrees = JSON.parse(JSON.stringify(rawWalls));
{
  const cxm = (rawTrees.cx + 0.5) * 512 / 16, cym = -(rawTrees.cy + 0.5) * 512 / 16;
  rawTrees.trees = [0, 1, 2, 3].map(i => ({ id: `arv_teste_${i}`, point: [cxm + i * 3, cym] }));
}
const rawTreesSnapshot = JSON.stringify(rawTrees);
console.log(`chunk de teste: ${rawWalls.cx}_${rawWalls.cy} (${wallScore}); árvores nos dados reais: ${treesInData} (usando 4 sintéticas)`);

// ============================================================ 1) camada de modificações
{
  const s = new ModStore();
  ok(s.isRendered("tree:a") && s.collisionEnabled("tree:a", true), "sem modificações: tudo visível e com colisão original");
  s.set("tree:a", { hidden: true });
  ok(!s.isRendered("tree:a") && s.collisionEnabled("tree:a", true), "ocultar é só visual: a colisão continua");
  s.set("tree:a", { removed: true });
  ok(!s.collisionEnabled("tree:a", true), "remover tira também a colisão");
  s.set("tree:a", { collision: true });
  ok(s.collisionEnabled("tree:a", true) && !s.isRendered("tree:a"), "colisão explícita vence e independe da aparência");
  s.restore("tree:a");
  ok(s.isRendered("tree:a") && s.size === 0, "restaurar apaga a entrada");
  s.set("tree:b", { collision: false });
  ok(s.isRendered("tree:b") && !s.collisionEnabled("tree:b", true), "colisão desligada com visual intacto");
  ok(s.set("tree:b", { collision: false }) === null, "reaplicar o mesmo estado não gera mudança");

  s.set("building:x:0", { hidden: true });
  ok(!s.isRendered("building:x:0#roof") && !s.isRendered("building:x:0#structure"), "ocultar a construção afeta as partes");
  s.restore("building:x:0");
  s.set("building:x:0#roof", { hidden: true });
  ok(!s.isRendered("building:x:0#roof") && s.isRendered("building:x:0#structure") && s.isRendered("building:x:0"),
    "telhado oculto sozinho: estrutura e construção seguem visíveis");

  const versionA = mapVersionKey({ chunkCacheKey: "cache-a", chunkManifest: { version: 1 } });
  const versionB = mapVersionKey({ chunkCacheKey: "cache-b", chunkManifest: { version: 1 } });
  ok(versionA !== versionB, "identidade do mapa usa cache_key, não só a versão do formato");
  const fallbackA = mapVersionKey({ chunkManifest: { version: 1, chunks: ["a"], meta: { osm_base_timestamp: "t1", counts: { roads: 1, lots: 2, buildings: 3 } } } });
  const fallbackB = mapVersionKey({ chunkManifest: { version: 1, chunks: ["a"], meta: { osm_base_timestamp: "t2", counts: { roads: 1, lots: 2, buildings: 3 } } } });
  ok(fallbackA !== fallbackB, "fallback da identidade do mapa inclui a origem dos dados");
  const json = JSON.parse(JSON.stringify(s.toJSON({ mapVersion: 1 })));
  const s2 = new ModStore(json);
  ok(JSON.stringify(s2.toJSON({ savedAt: "t" }).mods) === JSON.stringify(s.toJSON({ savedAt: "t" }).mods), "exportar -> importar reproduz as modificações");
  throws(() => parseMods("não é json"), "JSON inválido é recusado");
  throws(() => parseMods({ format: "outro", version: 1, mods: {} }), "arquivo de outro formato é recusado");
  throws(() => parseMods({ format: MODS_FORMAT, version: 99, mods: {} }), "versão futura é recusada");
  throws(() => parseMods({ format: MODS_FORMAT, version: 1, mods: { "casa:1": { hidden: true } } }), "ID de tipo desconhecido é recusado");
  const legacyVersion = parseMods(
    { format: MODS_FORMAT, version: 1, mapVersion: 1, mods: {} },
    { expectedMapVersion: "cache-a" }
  );
  ok(legacyVersion.mapVersion === null, "versão antiga do esquema é tratada como identidade desconhecida, sem perder edições");
  throws(
    () => parseMods({ format: MODS_FORMAT, version: 1, mapVersion: "map-a", mods: {} }, { expectedMapVersion: "map-b" }),
    "edições de outra versão do mapa são recusadas"
  );
  const keep = new ModStore(); keep.set("tree:k", { hidden: true });
  try { keep.load({ format: "x" }); } catch { /* esperado */ }
  ok(keep.size === 1, "importação recusada não altera o que já existe");
  throws(
    () => keep.load({ format: MODS_FORMAT, version: 1, mapVersion: "map-a", mods: { "tree:new": { removed: true } } }, { expectedMapVersion: "map-b" }),
    "versão incompatível é validada antes de modificar o armazenamento"
  );
  ok(keep.size === 1 && keep.entry("tree:k")?.hidden, "versão incompatível preserva as edições anteriores");
  const withAdded = new ModStore({ format: MODS_FORMAT, version: 1, mods: {}, added: [{ type: "casa-x", x: 1, y: 2 }] });
  ok(withAdded.toJSON().added.length === 1, "campo reservado `added` (Modo Construção) é preservado no JSON");

  // persistência local (storage falso)
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  const live = new ModStore(); const p1 = new ModPersistence(live, storage);
  live.set("tree:p", { removed: true });
  const reloaded = new ModStore(); const p2 = new ModPersistence(reloaded, storage);
  p2.load();
  ok(!reloaded.isRendered("tree:p"), "salvo localmente e recarregado em outra 'página'");
  const mismatchStorage = new Map();
  mismatchStorage.set(mods.STORAGE_KEY, JSON.stringify({
    format: MODS_FORMAT, version: 1, mapVersion: "map-a", mods: { "tree:old": { removed: true } }
  }));
  const mismatchStore = new ModStore();
  const mismatchLoad = new ModPersistence(mismatchStore, {
    getItem: k => mismatchStorage.get(k) ?? null,
    setItem: (k, v) => mismatchStorage.set(k, v),
    removeItem: k => mismatchStorage.delete(k)
  }, { meta: () => ({ mapVersion: "map-b" }) }).load();
  ok(!mismatchLoad.loaded && mismatchLoad.error && mismatchStore.size === 0,
    "storage de outra versão do mapa é recusado sem aplicar alterações");
  mem.set(mods.STORAGE_KEY, "{lixo");
  const broken = new ModStore(); const p3 = new ModPersistence(broken, storage);
  ok(p3.load().loaded === false && broken.size === 0, "storage corrompido não derruba o editor");
  const full = new ModPersistence(new ModStore(), { getItem: () => null, setItem() { throw new Error("quota"); }, removeItem() {} });
  ok(full.save() === false && full.lastError, "storage cheio/bloqueado: falha sem exceção");
}

// ============================================================ 2) muros por trecho (ID estável)
{
  ok(Boolean(wallLot), "há um lote real, ancorado no chunk, com muro de vários trechos para testar");
  if (!wallLot) process.exit(1);
  const again = planLotWall(wallLot.item.polygons[wallLot.i][0], {
    roadSegs: segs, seed: [...String(wallLot.item.feature.id)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261),
    blockSeed: 0
  });
  const pieces = wallLot.plan.collisions.map(c => c.piece);
  ok(new Set(pieces).size === pieces.length, `IDs de trecho são únicos (${pieces.join(", ")})`);
  ok(wallLot.plan.tops.length === wallLot.plan.collisions.length, "cada trecho tem topo e colisão com o mesmo ID");
  ok(wallLot.plan.tops.every(t => pieces.includes(t.piece)) && wallLot.plan.faces.every(f => pieces.includes(f.piece)), "faces e topos apontam para trechos existentes");
  ok(pieces.every(p => /^\d+\.\d+$/.test(p)), "formato do ID do trecho: aresta.trecho");
  ok(again === null || again.ok !== undefined, "replanejar o mesmo lote funciona (IDs derivam da geometria)");

  // edição individual sem afetar vizinhos
  const store = new ModStore();
  const lotKey = wallLot.key, target = pieces[1];
  store.set(ids.wallPiece(lotKey, target), { hidden: true });
  const view = applyWallMods(wallLot.plan, lotKey, store);
  ok(view.tops.length === wallLot.plan.tops.length - 1 && view.faces.every(f => f.piece !== target), "ocultar um trecho remove só o topo/faces dele");
  ok(view.tops.every(t => wallLot.plan.tops.includes(t)), "os demais trechos são os MESMOS objetos do plano (nada recalculado)");
  ok(view.collisions.length === wallLot.plan.collisions.length, "ocultar não remove a colisão do trecho");
  store.set(ids.wallPiece(lotKey, target), { removed: true });
  const v2 = applyWallMods(wallLot.plan, lotKey, store);
  ok(v2.collisions.length === wallLot.plan.collisions.length - 1 && !v2.collisions.some(c => c.piece === target), "remover tira a colisão só desse trecho");
  store.restore(ids.wallPiece(lotKey, target));
  store.set(ids.wallPiece(lotKey, pieces[0]), { collision: false });
  const v3 = applyWallMods(wallLot.plan, lotKey, store);
  ok(v3.tops.length === wallLot.plan.tops.length && v3.collisions.length === wallLot.plan.collisions.length - 1, "colisão desligada: visual intacto, colisão a menos");
  store.clear();
  store.set(ids.wall(lotKey), { removed: true });
  const v4 = applyWallMods(wallLot.plan, lotKey, store);
  ok(v4.tops.length === 0 && v4.pillars.length === 0 && v4.collisions.length === 0, "remover o muro inteiro remove tudo do lote");
  const none = applyWallMods(wallLot.plan, lotKey, new ModStore());
  ok(none.tops === wallLot.plan.tops && none.collisions === wallLot.plan.collisions && !none.changed, "sem modificações: devolve o plano original intacto");

  if (wallLot.plan.gate) {
    const gs = new ModStore();
    const closed = (gs.set(ids.gate(lotKey), { collision: true }), applyWallMods(wallLot.plan, lotKey, gs));
    ok(closed.collisions.length === wallLot.plan.collisions.length + 1, "portão: colisão ligada 'fecha' a passagem");
    ok(wallLot.plan.collisions.length === applyWallMods(wallLot.plan, lotKey, new ModStore()).collisions.length, "portão aberto por padrão: o original não muda");
  } else console.log("(lote escolhido não tem portão; coberto abaixo se houver outro)");
}

// ============================================================ 3) integração real com chunks
// 3a) árvores
{
  const store = new ModStore();
  const { m } = makeManager({ store });
  const chunk = loadChunk(m, rawTrees);
  m.syncCollisionArrays();
  const trees = chunk.record.trees;
  ok(trees.length >= 2, `chunk com árvores carregado (${trees.length})`);
  const before = { trees: trees.length, collisions: m.treeCollision.length };
  const target = trees[0], neighbor = trees[1];
  const session = new EditorSession(m, store);

  session.apply([ids.tree(target.feature.id)], { removed: true }, "remover árvore");
  ok(chunk.record.trees.length === before.trees - 1, "remover: a árvore some do desenho");
  ok(!chunk.record.trees.some(t => t.feature.id === target.feature.id), "…e é exatamente a selecionada");
  ok(chunk.record.trees.some(t => t.feature.id === neighbor.feature.id), "árvores vizinhas continuam");
  ok(m.treeCollision.length === before.collisions - 1 && !m.treeCollision.some(c => c.key === `tree:${target.feature.id}`), "colisão sincronizada: a da árvore removida também sumiu");
  ok(chunk.record.editorHidden.some(h => h.id === ids.tree(target.feature.id)), "elemento removido fica listado para restauração");

  session.apply([ids.tree(neighbor.feature.id)], { hidden: true }, "ocultar");
  ok(!chunk.record.trees.some(t => t.feature.id === neighbor.feature.id) && m.treeCollision.some(c => c.key === `tree:${neighbor.feature.id}`), "ocultar: some da tela, mas ainda bloqueia");
  const third = chunk.record.trees[0];
  session.apply([ids.tree(third.feature.id)], { collision: false }, "colisão");
  ok(chunk.record.trees.some(t => t.feature.id === third.feature.id) && !m.treeCollision.some(c => c.key === `tree:${third.feature.id}`), "colisão desligada: continua visível, não bloqueia");

  // desfazer / refazer
  ok(session.undo() && m.treeCollision.some(c => c.key === `tree:${third.feature.id}`), "desfazer devolve a colisão");
  ok(session.undo() && chunk.record.trees.some(t => t.feature.id === neighbor.feature.id), "desfazer devolve a árvore oculta");
  ok(session.undo() && chunk.record.trees.length === before.trees && m.treeCollision.length === before.collisions, "desfazer tudo volta ao estado original (visual e colisão)");
  ok(session.undo() === null, "sem mais nada para desfazer: retorna null");
  ok(session.redo() && chunk.record.trees.length === before.trees - 1, "refazer reaplica a remoção");
  session.undo();
  session.apply([ids.tree(neighbor.feature.id)], { hidden: true }, "nova edição");
  ok(session.redo() === null, "uma edição nova invalida o 'refazer'");

  // persistência: descarregar e recarregar o chunk
  session.undo();
  session.apply([ids.tree(target.feature.id)], { removed: true }, "remover árvore");
  m.destroyChunk(chunk);
  ok(!m.loaded.has(chunk.key), "chunk descarregado");
  const reloaded = loadChunk(m, rawTrees);
  m.syncCollisionArrays();
  ok(!reloaded.record.trees.some(t => t.feature.id === target.feature.id), "após recarregar o chunk: árvore continua removida");
  ok(reloaded.record.trees.length === before.trees - 1 && m.treeCollision.length === before.collisions - 1, "…e a colisão também (visual e colisão sincronizados)");

  // persistência: "recarregar a página" (nova cena, novo manager, storage)
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  const s1 = new ModStore(); const per1 = new ModPersistence(s1, storage);
  s1.set(ids.tree(target.feature.id), { removed: true });
  const s2 = new ModStore(); new ModPersistence(s2, storage).load();
  const page2 = makeManager({ store: s2 });
  const c2 = loadChunk(page2.m, rawTrees);
  page2.m.syncCollisionArrays();
  ok(!c2.record.trees.some(t => t.feature.id === target.feature.id) && c2.record.trees.length === before.trees - 1, "após recarregar a PÁGINA: a árvore removida não volta");
  ok(page2.m.treeCollision.length === before.collisions - 1, "…nem a colisão dela");

  // os dados originais não foram alterados
  ok(JSON.stringify(rawTrees) === rawTreesSnapshot, "o JSON original do chunk não foi alterado");
  ok(rawTrees.trees.some(t => t.id === target.feature.id), "…e a árvore continua nos dados originais");
  const diskChunk = data(`chunks/${rawWalls.cx}_${rawWalls.cy}.json`);
  ok(JSON.stringify(diskChunk) === JSON.stringify(rawWalls), "o arquivo de dados em disco também não foi alterado");

  // sem camada = comportamento original
  const plain = makeManager();
  const pc = loadChunk(plain.m, rawTrees);
  plain.m.syncCollisionArrays();
  ok(pc.record.trees.length === before.trees && plain.m.treeCollision.length === before.collisions, "sem camada de modificações o chunk é idêntico ao original");
  session.dispose();
}

// 3b) muros e construções no chunk com lotes
{
  const store = new ModStore();
  const { m, scene } = makeManager({ store });
  const chunk = loadChunk(m, rawWalls);
  m.syncCollisionArrays();
  const wallColl = () => (chunk.record.collisions.find(c => c.key === `walls:${chunk.key}`)?.segments || []);
  const baseSegs = wallColl().length;
  ok(baseSegs > 0 && m.wallCollision.length > 0, `muros desenhados e com colisão (${baseSegs} trechos)`);
  const lot = wallLot;
  const session = new EditorSession(m, store);
  const wallFaceGraphics = () => scene.created.filter(o => o.depth === 33 && !o.destroyed);

  const pieceId = ids.wallPiece(lot.key, lot.plan.collisions[0].piece);
  const neighborId = ids.wallPiece(lot.key, lot.plan.collisions[1].piece);
  session.apply([pieceId], { removed: true }, "remover trecho");
  ok(wallColl().length === baseSegs - 1, "remover um trecho: só um trecho a menos na colisão do chunk");
  ok(m.wallCollision.reduce((n, c) => n + c.segments.length, 0) === baseSegs - 1, "…e o array global de colisões do jogo acompanha");
  ok(wallColl().some(s => s.piece === lot.plan.collisions[1].piece), "o trecho vizinho continua colidindo");
  ok(chunk.record.editorHidden.some(h => h.id === pieceId && h.kind === "wall"), "trecho removido listado para restauração");
  ok(wallFaceGraphics().length >= 1, "muros continuam sendo desenhados (só o trecho saiu)");

  session.apply([neighborId], { hidden: true }, "ocultar trecho");
  ok(wallColl().length === baseSegs - 1, "ocultar o vizinho não mexe na colisão dele");
  session.undo(); session.undo();
  ok(wallColl().length === baseSegs, "desfazer restaura a colisão original dos muros");

  // portão
  if (lot.plan.gate) {
    session.apply([ids.gate(lot.key)], { collision: true }, "fechar portão");
    ok(wallColl().length === baseSegs + 1, "fechar o portão adiciona a colisão da passagem");
    session.undo();
    ok(wallColl().length === baseSegs, "abrir de novo restaura");
  }

  // construções: estrutura e telhado separados
  const b = chunk.record.buildings[0];
  const bid = ids.building(b.feature.id, 0);
  const bBase = chunk.record.collisions.filter(c => c.rings).length;
  ok(bBase >= 1, `construções com colisão (${bBase})`);
  const gfx = () => scene.created.filter(o => !o.destroyed).length;
  const objsBefore = chunk.objects.length;
  session.apply([ids.part(bid, "roof")], { hidden: true }, "ocultar telhado");
  ok(chunk.record.collisions.filter(c => c.rings).length === bBase, "ocultar só o telhado não mexe na colisão");
  ok(chunk.record.editorHidden.some(h => h.id === bid && h.parts.join() === "roof"), "telhado oculto listado como parte");
  ok(chunk.objects.length < objsBefore, "o objeto de telhado deixou de existir no chunk");
  session.undo();
  ok(chunk.objects.length === objsBefore, "desfazer devolve exatamente os mesmos objetos");
  session.apply([bid], { removed: true }, "remover construção");
  ok(chunk.record.collisions.filter(c => c.rings).length === bBase - 1 && !m.buildingCollision.some(c => c.key === `${b.feature.id}:0`), "remover construção: colisão some, sincronizada");
  session.apply([bid], { collision: true }, "colisão");
  ok(m.buildingCollision.some(c => c.key === `${b.feature.id}:0`), "colisão pode continuar mesmo com a aparência removida");
  session.undo(); session.undo();
  ok(chunk.record.collisions.filter(c => c.rings).length === bBase, "desfazer: construção e colisão voltam");
  ok(gfx() > 0, "objetos continuam existindo");

  // seleção individual
  const center = { x: (b.bounds.minX + b.bounds.maxX) / 2, y: (b.bounds.minY + b.bounds.maxY) / 2 };
  const cands = pickCandidates(m, center);
  ok(cands.some(c => c.id === bid && c.kind === "building"), "clicar na construção a seleciona (ID estável)");
  ok(cands.length === new Set(cands.map(c => c.id)).size, "candidatos sem duplicatas");
  const lotCand = cands.find(c => c.kind === "lot");
  if (lotCand) {
    const assoc = lotAssociations(m, lotCand);
    ok(assoc.buildings.every(x => x.kind === "building") && Array.isArray(assoc.trees), "lote: lista elementos associados");
    ok(describeElement(m, store, lotCand).some(([k]) => k === "id"), "lote descrito no painel");
  }
  const located = locateElement(m, bid);
  ok(located && located.id === bid && located.bounds, "locateElement resolve o ID para o elemento");
  ok(locateElement(m, "tree:inexistente") === null, "ID fora dos chunks carregados retorna null");

  // o elemento ao lado não é afetado pela edição de outro (mesma lista de IDs)
  const before = JSON.stringify(chunk.record.buildings.map(x => x.feature.id));
  session.apply([bid], { hidden: true }, "ocultar");
  ok(JSON.stringify(chunk.record.buildings.map(x => x.feature.id)) === before, "ocultar não apaga dados da construção; só o desenho");

  // persistência de muros/construções ao recarregar o chunk
  session.undo();
  session.apply([pieceId], { removed: true }, "remover trecho");
  m.destroyChunk(chunk);
  const again = loadChunk(m, rawWalls);
  const againSegs = again.record.collisions.find(c => c.key === `walls:${again.key}`)?.segments || [];
  ok(againSegs.length === baseSegs - 1, "após recarregar o chunk: trecho removido continua removido");
  session.dispose();
}

// 3c) edição enquanto um chunk compartilhado ainda está sendo montado
{
  const store = new ModStore();
  const { m } = makeManager({ store });
  const cx = rawWalls.cx, cy = rawWalls.cy;
  const left = cx * 512 + 100, right = cx * 512 + 1400;
  const top = cy * 512 + 120, bottom = cy * 512 + 300;
  const point = (x, y) => [x / 16, -y / 16];
  const ring = [
    point(left, top), point(right, top), point(right, bottom),
    point(left, bottom), point(left, top)
  ];
  const feature = {
    id: "editor_race_building",
    building_type: "unknown",
    area_m2: 30,
    polygons: [[ring]]
  };
  const rawAt = (chunkX) => ({
    cx: chunkX, cy,
    blocks: [], lots: [], roads: [], buildings: [feature], trees: [], labels: []
  });

  const first = loadChunk(m, rawAt(cx));
  const second = loadChunk(m, rawAt(cx + 1));
  m.syncCollisionArrays();

  const buildingId = ids.building(feature.id, 0);
  const third = m.createChunk(cx + 2, cy);
  third.state = "building";
  third.buildRaw = rawAt(cx + 2);
  third.buildStage = 0;
  m.buildQueue.push(third);
  m.maxBuildStepsPerFrame = 7;
  m.buildBudgetMs = 1e9;
  m.processReadyChunks();

  ok(third.state === "building" && third.buildStage === 7,
    "terceiro chunk pausado após desenhar a construção, antes da última etapa");
  ok(third.record?.collisions.some(c => c.key === "editor_race_building:0"),
    "chunk em montagem ainda contém a colisão antiga antes da edição");

  const session = new EditorSession(m, store);
  session.apply([buildingId], { removed: true }, "remover construção compartilhada");
  ok(third.editorDirty === true,
    "edição invalida o chunk em montagem que intersecta a construção");
  ok(!m.buildingCollision.some(c => c.key === "editor_race_building:0"),
    "colisões de chunks ainda em montagem não vazam para o jogo");

  m.maxBuildStepsPerFrame = 1;
  for (let i = 0; i < 40 && third.state !== "loaded"; i++) m.processReadyChunks();
  m.syncCollisionArrays();

  ok(third.state === "loaded" && !third.editorDirty,
    "chunk termina de carregar após reiniciar suas etapas");
  for (const chunk of [first, second, third]) {
    ok(!chunk.record.collisions.some(c => c.key === "editor_race_building:0"),
      "colisão da construção removida não permanece no chunk " + chunk.key);
    ok(chunk.record.editorHidden.some(h => h.id === buildingId),
      "construção removida continua recuperável no chunk " + chunk.key);
  }
  ok(!m.buildingCollision.some(c => c.key === "editor_race_building:0"),
    "nenhum dos três chunks mantém colisão fantasma após a montagem");
  session.dispose();
}

// 3d) o payload reservado do Modo Construção também é desfazível
{
  const { m } = makeManager();
  const store = new ModStore();
  const session = new EditorSession(m, store);
  const added = [{ id: "placed-house-1", type: "house", x: 20, y: 40, rotation: 0 }];
  session.replaceAll({
    format: MODS_FORMAT, version: 1, mapVersion: "cache-a", mods: {}, added
  }, { expectedMapVersion: "cache-a" });
  ok(store.added.length === 1 && store.totalCount === 1, "importação preserva e contabiliza objetos adicionados para futura Construção");
  ok(session.undo() && store.added.length === 0, "desfazer importação também desfaz objetos adicionados");
  ok(session.redo() && store.added.length === 1 && store.added[0].id === "placed-house-1",
    "refazer recupera objetos adicionados e suas propriedades");
  session.clearAll();
  ok(store.added.length === 0 && store.totalCount === 0, "restaurar tudo também limpa e contabiliza objetos adicionados");
  ok(session.undo() && store.added.length === 1, "desfazer restaurar tudo devolve objetos adicionados");
  session.dispose();
}

// ============================================================ 4) Inspector e sistemas existentes
{
  const store = new ModStore();
  const { m } = makeManager({ store });
  const chunk = loadChunk(m, rawTrees);
  const session = new EditorSession(m, store);
  const t = chunk.record.trees[0];
  ok(inspector.pickTree(m, t.point)?.item === t, "Inspector: seleciona a árvore enquanto ela existe");
  session.apply([ids.tree(t.feature.id)], { removed: true }, "remover");
  ok(!inspector.pickTree(m, t.point) || inspector.pickTree(m, t.point).item !== t, "Inspector: não vê a árvore removida");
  session.undo();
  ok(inspector.pickTree(m, chunk.record.trees.find(x => x.feature.id === t.feature.id).point), "Inspector: vê de novo após desfazer");
  ok(typeof inspector.describeObject(inspector.pickObject(m, t.point), m) === "object", "Inspector: descrição continua funcionando");
  const d = inspector.describeChunk(m, chunk.cx, chunk.cy);
  ok(d.loaded && d.counts && d.counts.colisões > 0, "Inspector: contagens de chunk continuam funcionando");
  session.dispose();

  // wall + Inspector
  const w = makeManager({ store: new ModStore() });
  const c2 = loadChunk(w.m, rawWalls);
  const sess = new EditorSession(w.m, w.m.worldMods);
  const seg = wallLot.plan.collisions[0];
  const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
  ok(inspector.pickWall(w.m, mid)?.kind === "wall", "Inspector: acha o trecho de muro");
  sess.apply([ids.wallPiece(wallLot.key, seg.piece)], { removed: true }, "remover");
  const after = inspector.pickWall(w.m, mid);
  ok(!after || after.segment.piece !== seg.piece, "Inspector: não vê o trecho removido");
  sess.dispose();
}

// ============================================================ 5) modos (Edição / Construção)
{
  const reg = new modes.ModeRegistry();
  ok(reg.activeId === "edit" && reg.list().map(x => x.id).join() === "edit,build", "dois modos independentes registrados");
  const r = reg.switchTo("build");
  ok(!r.ok && reg.activeId === "edit" && /breve/i.test(r.reason), "Modo Construção reservado: recusa com mensagem e não quebra o editor");
  ok(!reg.switchTo("nada").ok, "modo inexistente é recusado");
  const lib = new modes.ElementLibrary().register({ type: "casa-simples", label: "Casa simples", category: "casas" });
  ok(lib.list("casas").length === 1 && lib.get("casa-simples").label === "Casa simples", "biblioteca de elementos pronta para o Modo Construção");
  throws(() => lib.register({ label: "sem tipo" }), "definição inválida é recusada");
  class Fake extends modes.BuildMode { constructor() { super(); this.enabled = true; } }
  const reg2 = new modes.ModeRegistry([new modes.EditMode(), new Fake()]);
  ok(reg2.switchTo("build").ok && reg2.activeId === "build", "um modo novo habilitado entra sem mudar o editor");
}

console.log(failed ? `\n${failed} TESTE(S) FALHARAM` : "\nTODOS OS TESTES PASSARAM");
process.exit(failed ? 1 : 0);
