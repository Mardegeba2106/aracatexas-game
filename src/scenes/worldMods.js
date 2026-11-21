// Camada de modificações do mundo (World Editor).
//
// Os dados originais do mapa NUNCA são alterados. Esta camada é independente:
// um dicionário { idEstável: { removed?, hidden?, collision? } } que o
// WorldChunkManager consulta ao desenhar e ao montar colisões. Por isso a edição
// sobrevive a descarregar/recarregar chunks e a recarregar a página.
//
// Módulo puro (sem Phaser e sem DOM): roda no jogo e nos testes em Node.

export const MODS_FORMAT = "aracatexas-world-mods";
export const MODS_VERSION = 1;
export const STORAGE_KEY = "aracatexas.worldmods.v1";

// Usa a mesma identidade de cache dos chunks calculada pelo mapLoader.
// A versão do manifesto identifica seu formato, não a identidade do mapa.
export function mapVersionKey(mapData) {
  if (!mapData) return null;
  if (mapData.chunkCacheKey != null) return String(mapData.chunkCacheKey);
  const manifest = mapData.chunkManifest ?? mapData.manifest ?? null;
  if (!manifest) return null;
  if (manifest.cache_version != null) return encodeURIComponent(String(manifest.cache_version));
  const meta = manifest.meta ?? {};
  const counts = meta.counts ?? {};
  return encodeURIComponent([
    meta.osm_base_timestamp || "map",
    manifest.chunk_count || manifest.chunks?.length || 0,
    counts.roads || 0,
    counts.lots || 0,
    counts.buildings || 0
  ].join("-"));
}

// ------------------------------------------------------------- IDs estáveis
// Derivados dos IDs do mapa (que não mudam entre carregamentos), nunca de índices de
// chunk ou ordem de desenho. Partes de um elemento usam "#parte".
//   building:<id>:<poligono>  #structure | #roof
//   tree:<id>
//   wall:<lote>:<poligono>    (muro inteiro)  ->  wall:<lote>:<poligono>#<aresta>.<trecho>
//   gate:<lote>:<poligono>
//   lot:<id>:<poligono>       (só seleção)
export const ids = {
  building: (featureId, polygonIndex = 0) => `building:${featureId ?? "building"}:${polygonIndex}`,
  tree: featureId => `tree:${featureId}`,
  lot: (featureId, polygonIndex = 0) => `lot:${featureId ?? "lote"}:${polygonIndex}`,
  wall: lotKey => `wall:${lotKey}`,
  wallPiece: (lotKey, piece) => `wall:${lotKey}#${piece}`,
  gate: lotKey => `gate:${lotKey}`,
  part: (id, part) => `${id}#${part}`
};

export const kindOf = id => String(id).split(":")[0];
export const parentOf = id => {
  const i = String(id).indexOf("#");
  return i < 0 ? null : String(id).slice(0, i);
};

const VALID_KEYS = new Set(["removed", "hidden", "collision"]);

// Normaliza uma entrada: só chaves conhecidas, e "vazia" vira null (= sem modificação).
export function cleanEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  if (entry.removed === true) out.removed = true;
  if (entry.hidden === true) out.hidden = true;
  if (entry.collision === true || entry.collision === false) out.collision = entry.collision;
  return Object.keys(out).length ? out : null;
}

export class ModStore {
  constructor(initial = null) {
    this.mods = new Map();
    this.added = []; // reservado para o Modo Construção (itens novos); preservado no export/import
    this.listeners = new Set();
    this.revision = 0;
    if (initial) this.load(initial, { silent: true });
  }

  get size() { return this.mods.size; }
  get totalCount() { return this.mods.size + this.added.length; }
  entry(id) { return this.mods.get(id) || null; }
  ids() { return [...this.mods.keys()]; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Estado efetivo: a entrada própria sobrepõe a do pai (parte -> elemento -> muro inteiro).
  // remover/ocultar o pai afeta as partes; `collision` explícito da parte tem prioridade.
  effective(id) {
    const own = this.mods.get(id) || null;
    const parentId = parentOf(id);
    let parent = parentId ? this.effective(parentId) : null;
    // Um trecho de muro herda também do muro inteiro (wall:lote#e.p -> wall:lote).
    const out = { removed: false, hidden: false, collision: undefined };
    for (const src of [parent, own]) {
      if (!src) continue;
      if (src.removed) out.removed = true;
      if (src.hidden) out.hidden = true;
      if (src.collision !== undefined) out.collision = src.collision;
    }
    return out;
  }

  // Visível = desenhar. Removido ou oculto não é desenhado.
  isRendered(id) {
    const e = this.effective(id);
    return !e.removed && !e.hidden;
  }

  // Colisão: override explícito vence; senão removido = sem colisão; oculto = mantém
  // (ocultar é só visual). `fallback` é o comportamento original do elemento.
  collisionEnabled(id, fallback = true) {
    const e = this.effective(id);
    if (e.collision !== undefined) return e.collision;
    if (e.removed) return false;
    return fallback;
  }

  // ---- escrita (sempre por patch; null apaga a entrada = restaurar) ----------
  // Retorna { id, before, after } para o histórico, ou null se nada mudou.
  set(id, patch, { silent = false } = {}) {
    const before = this.entry(id);
    const merged = patch === null ? null : cleanEntry({ ...(before || {}), ...patch });
    // chaves com undefined/null no patch removem a chave
    if (patch && merged) {
      for (const k of Object.keys(patch)) if (patch[k] === null || patch[k] === undefined) delete merged[k];
    }
    const after = merged && Object.keys(merged).length ? merged : null;
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    if (after) this.mods.set(id, after); else this.mods.delete(id);
    this.revision++;
    const change = { id, before: before ? { ...before } : null, after: after ? { ...after } : null };
    if (!silent) this.emit([change]);
    return change;
  }

  // Aplica entradas exatas (usado por desfazer/refazer): { id: entry|null }.
  setExact(map, { silent = false } = {}) {
    const changes = [];
    for (const [id, entry] of Object.entries(map)) {
      const before = this.entry(id);
      const after = cleanEntry(entry);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after) this.mods.set(id, after); else this.mods.delete(id);
      changes.push({ id, before: before ? { ...before } : null, after: after ? { ...after } : null });
    }
    if (changes.length) { this.revision++; if (!silent) this.emit(changes); }
    return changes;
  }

  restore(id) { return this.set(id, null); }

  clear({ silent = false } = {}) {
    const changes = [...this.mods.entries()].map(([id, e]) => ({ id, before: { ...e }, after: null }));
    const addedChanged = this.added.length > 0;
    this.mods.clear();
    this.added = [];
    if (changes.length || addedChanged) {
      this.revision++;
      if (!silent) this.emit(changes);
    }
    return changes;
  }

  emit(changes) { for (const fn of this.listeners) fn(changes, this); }

  // ---- serialização -----------------------------------------------------------
  toJSON(meta = {}) {
    const mods = {};
    for (const [id, e] of [...this.mods.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) mods[id] = { ...e };
    const payload = {
      format: MODS_FORMAT, version: MODS_VERSION,
      mapVersion: meta.mapVersion ?? null,
      savedAt: meta.savedAt ?? new Date().toISOString(),
      mods, added: this.added.map(a => ({ ...a }))
    };
    if (Number.isInteger(meta.defaultsVersion) && meta.defaultsVersion >= 1) {
      payload.defaultsVersion = meta.defaultsVersion;
    }
    return payload;
  }

  // Substitui o conteúdo (importar/restaurar). Lança Error com mensagem em PT se inválido.
  load(payload, { silent = false, merge = false, expectedMapVersion = null } = {}) {
    const parsed = parseMods(payload, { expectedMapVersion });
    const before = new Map(this.mods);
    if (!merge) this.mods.clear();
    for (const [id, entry] of Object.entries(parsed.mods)) this.mods.set(id, entry);
    if (!merge) this.added = parsed.added; else this.added.push(...parsed.added);
    this.revision++;
    const changes = [];
    const allIds = new Set([...before.keys(), ...this.mods.keys()]);
    for (const id of allIds) {
      const b = before.get(id) || null, a = this.mods.get(id) || null;
      if (JSON.stringify(b) !== JSON.stringify(a)) changes.push({ id, before: b, after: a });
    }
    if (!silent && changes.length) this.emit(changes);
    return changes;
  }
}

// Valida e normaliza um JSON de modificações (string ou objeto).
export function parseMods(payload, { expectedMapVersion = null } = {}) {
  let data = payload;
  if (typeof payload === "string") {
    try { data = JSON.parse(payload); } catch { throw new Error("JSON inválido."); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Formato inválido: esperado um objeto.");
  if (data.format !== MODS_FORMAT) throw new Error(`Arquivo não é do World Editor (format "${data.format}").`);
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error("Versão inválida.");
  if (data.version > MODS_VERSION) throw new Error(`Versão ${data.version} é mais nova que a suportada (${MODS_VERSION}).`);
  if (!data.mods || typeof data.mods !== "object" || Array.isArray(data.mods)) throw new Error("Campo 'mods' ausente ou inválido.");
  const mods = {};
  for (const [id, entry] of Object.entries(data.mods)) {
    if (!/^(building|tree|wall|gate|lot):/.test(id)) throw new Error(`ID de elemento inválido: "${id}".`);
    const clean = cleanEntry(entry);
    if (clean) mods[id] = clean;
  }
  const rawMapVersion = data.mapVersion ?? null;
  // Versões antigas do ZIP gravavam manifest.version (inteiro) como se fosse
  // identidade do mapa. Esse número identifica o esquema, então é desconhecido.
  const legacySchemaVersion = typeof rawMapVersion === "number" ||
    (typeof rawMapVersion === "string" && /^\d+$/.test(rawMapVersion));
  const mapVersion = legacySchemaVersion ? null : rawMapVersion;
  if (expectedMapVersion != null && mapVersion != null &&
      String(mapVersion) !== String(expectedMapVersion)) {
    throw new Error(
      "As modificações pertencem à versão " + mapVersion +
      " do mapa; a versão atual é " + expectedMapVersion + ". " +
      "As alterações não foram aplicadas para evitar editar elementos incorretos."
    );
  }
  const added = Array.isArray(data.added) ? data.added.filter(a => a && typeof a === "object") : [];
  return {
    mods, added, mapVersion,
    defaultsVersion: Number.isInteger(data.defaultsVersion) && data.defaultsVersion >= 1
      ? data.defaultsVersion
      : null
  };
}

// ----------------------------------------------------------- persistência local
export class ModPersistence {
  // storage: qualquer objeto com getItem/setItem/removeItem (localStorage ou fake nos testes).
  constructor(store, storage, { key = STORAGE_KEY, meta = () => ({}), baselineVersion = null } = {}) {
    this.store = store;
    this.storage = storage;
    this.key = key;
    this.meta = meta;
    this.baselineVersion = baselineVersion;
    this.lastError = null;
    this.unsubscribe = store.onChange(() => this.save());
  }

  save() {
    try {
      const meta = { ...this.meta() };
      if (this.baselineVersion != null) meta.defaultsVersion = this.baselineVersion;
      this.storage.setItem(this.key, JSON.stringify(this.store.toJSON(meta)));
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error; // cota cheia / storage bloqueado: o editor continua em memória
      return false;
    }
  }

  // Carrega do storage sem disparar eventos (o chamador reconstrói os chunks).
  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return { loaded: false, count: 0 };
      const expectedMapVersion = this.meta()?.mapVersion ?? null;
      const parsed = parseMods(raw, { expectedMapVersion });
      // Armazenamentos antigos não conhecem o baseline do projeto. Mescla-os uma vez
      // sobre a configuração oficial e grava o marcador para as próximas inicializações.
      const migrateBaseline = this.baselineVersion != null && parsed.defaultsVersion !== this.baselineVersion;
      this.store.load(raw, { silent: true, expectedMapVersion, merge: migrateBaseline });
      if (migrateBaseline) this.save();
      return {
        loaded: true,
        count: this.store.size,
        warning: parsed.mapVersion == null && expectedMapVersion != null
          ? "As alterações salvas não informam a versão do mapa; confira a compatibilidade."
          : null
      };
    } catch (error) {
      this.lastError = error;
      return { loaded: false, count: 0, error };
    }
  }

  wipe() { try { this.storage.removeItem(this.key); } catch { /* ignora */ } }
  dispose() { this.unsubscribe?.(); }
}

// --------------------------------------------------------- muros por trecho
// Aplica as modificações a UM plano de muro (planLotWall) e devolve o que deve ser
// desenhado/colidir. Não altera o plano (que fica em cache no chunk manager).
// Os trechos vizinhos nunca são afetados: cada um tem seu próprio ID.
export function applyWallMods(plan, lotKey, store) {
  if (!plan) return null;
  if (!store || store.size === 0) {
    return { faces: plan.faces, tops: plan.tops, pillars: plan.pillars, collisions: plan.collisions,
      hiddenPieces: [], changed: false };
  }
  const wallId = ids.wall(lotKey);
  const gateId = ids.gate(lotKey);
  const pieceRendered = piece => store.isRendered(ids.wallPiece(lotKey, piece));
  const pieceCollides = piece => store.collisionEnabled(ids.wallPiece(lotKey, piece), true);

  const faces = plan.faces.filter(f => f.piece === undefined || pieceRendered(f.piece));
  const tops = plan.tops.filter(t => t.piece === undefined || pieceRendered(t.piece));
  const collisions = plan.collisions.filter(c => c.piece === undefined || pieceCollides(c.piece));

  // Pilar: some se a aresta inteira (todos os trechos) está invisível; pilares do
  // portão seguem o portão. Pilares sem aresta (dados antigos) seguem o muro inteiro.
  const piecesByEdge = new Map();
  for (const c of plan.collisions) {
    if (c.piece === undefined) continue;
    const edge = String(c.piece).split(".")[0];
    if (!piecesByEdge.has(edge)) piecesByEdge.set(edge, []);
    piecesByEdge.get(edge).push(c.piece);
  }
  const wallRendered = store.isRendered(wallId);
  const gateRendered = store.isRendered(gateId);
  const pillars = plan.pillars.filter(p => {
    if (!wallRendered) return false;
    if (p.gate) return gateRendered;
    if (p.edge === null || p.edge === undefined) return true;
    const pieces = piecesByEdge.get(String(p.edge));
    if (!pieces || !pieces.length) return true;
    return pieces.some(pieceRendered);
  });

  // Portão: por padrão é uma abertura. Com colisão explícita ligada, "fecha" a passagem.
  if (plan.gateSegment && store.effective(gateId).collision === true) {
    collisions.push({ a: plan.gateSegment.a, b: plan.gateSegment.b, piece: "gate" });
  }
  const hiddenPieces = plan.collisions.filter(c => c.piece !== undefined && !pieceRendered(c.piece)).map(c => c.piece);
  return { faces, tops, pillars, collisions, hiddenPieces, changed: true };
}
