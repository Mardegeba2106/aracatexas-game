// World Editor: modos independentes.
//
//  - EditMode  (implementado): seleciona e modifica o que já existe no mapa.
//  - BuildMode (reservado):    adicionar construções/objetos de uma biblioteca.
//
// Um modo é um objeto com o contrato abaixo; o WorldEditor só conversa com esse contrato,
// então implementar o Modo Construção não exige reconstruir o editor:
//
//   id, label, enabled
//   activate(editor) / deactivate(editor)
//   onPointerDown(editor, world, event) -> boolean (true = consumiu o clique)
//   onKeyDown(editor, event)            -> boolean
//   draw(editor, graphics, zoom)        -> desenha o overlay do modo
//   panelSections(editor)               -> seções extras do painel (ver worldEditorPanel.js)
//
// Persistência para o Modo Construção: ModStore.added (lista de itens novos) já é salvo,
// exportado e importado junto com as modificações. Falta apenas o desenho desses itens
// (gancho previsto: WorldChunkManager lê store.added por chunk, como já faz com `mods`).

// ---- biblioteca de elementos (usada pelo Modo Construção) --------------------
export class ElementLibrary {
  constructor() { this.defs = new Map(); }
  // def: { type, label, category, defaults: {...}, draw?(scene, chunk, item) }
  register(def) {
    if (!def?.type || !def.label) throw new Error("Definição de elemento inválida (type e label).");
    this.defs.set(def.type, { category: "geral", defaults: {}, ...def });
    return this;
  }
  get(type) { return this.defs.get(type) || null; }
  list(category = null) {
    return [...this.defs.values()].filter(d => !category || d.category === category);
  }
}

export class EditMode {
  constructor() { this.id = "edit"; this.label = "Edição"; this.enabled = true; }
  activate() {}
  deactivate() {}
  // Clique: seleciona (a lógica de seleção/ciclo fica no WorldEditor).
  onPointerDown(editor, world) { editor.selectAt(world); return true; }
  onKeyDown() { return false; }
  draw() {}
  panelSections() { return []; }
}

export class BuildMode {
  constructor(library = new ElementLibrary()) {
    this.id = "build";
    this.label = "Construção";
    this.enabled = false; // ainda não implementado nesta versão
    this.reason = "Em breve: adicionar construções e objetos de uma biblioteca.";
    this.library = library;
    this.pending = null; // elemento escolhido da biblioteca, aguardando posicionamento
  }
  activate() {}
  deactivate() { this.pending = null; }
  onPointerDown() { return false; }
  onKeyDown() { return false; }
  draw() {}
  panelSections() { return []; }
}

export class ModeRegistry {
  constructor(modes = [new EditMode(), new BuildMode()]) {
    this.modes = new Map(modes.map(m => [m.id, m]));
    this.activeId = "edit";
  }
  get active() { return this.modes.get(this.activeId); }
  list() { return [...this.modes.values()]; }
  // Retorna { ok, reason }: modo reservado/desabilitado não troca (e não quebra o editor).
  switchTo(id, editor = null) {
    const next = this.modes.get(id);
    if (!next) return { ok: false, reason: `Modo desconhecido: ${id}` };
    if (!next.enabled) return { ok: false, reason: next.reason || "Modo indisponível." };
    if (next === this.active) return { ok: true };
    this.active.deactivate?.(editor);
    this.activeId = id;
    next.activate?.(editor);
    return { ok: true };
  }
}
