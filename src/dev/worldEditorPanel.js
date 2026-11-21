// Painel do World Editor (DOM). Só existe em desenvolvimento.
// Fica no canto ESQUERDO; o World Inspector (F7) usa o direito, então os dois
// podem ficar abertos juntos. Não conhece Phaser: recebe `state` e chama callbacks.

const CSS = `
.wed{position:fixed;left:10px;top:10px;width:290px;max-height:calc(100vh - 20px);overflow:auto;z-index:1500;
 background:rgba(14,26,20,.92);color:#d8e6c5;font:11px/1.35 Consolas,monospace;border:1px solid #3d5a47;
 border-radius:6px;padding:8px;box-sizing:border-box;display:none;user-select:none}
.wed.open{display:block}
.wed h3{margin:0 0 6px;font-size:12px;color:#ffdf78;display:flex;justify-content:space-between;align-items:center}
.wed h4{margin:8px 0 4px;font-size:11px;color:#9fd0ff;border-top:1px solid #2c4435;padding-top:6px}
.wed button{font:inherit;background:#22382b;color:#d8e6c5;border:1px solid #3d5a47;border-radius:4px;
 padding:3px 6px;margin:0 3px 3px 0;cursor:pointer}
.wed button:hover:not(:disabled){background:#2f4d3b}
.wed button:disabled{opacity:.4;cursor:default}
.wed button.on{background:#51622f;border-color:#ffdf78;color:#ffdf78}
.wed button.danger{border-color:#a24c4c}
.wed .row{display:flex;gap:6px}.wed .row span:first-child{color:#8fb09a;min-width:74px}
.wed .item{cursor:pointer;padding:1px 3px;border-radius:3px;display:flex;justify-content:space-between;gap:6px}
.wed .item:hover{background:#26402f}
.wed .muted{color:#7f9a88}.wed .msg{color:#ffb86b;margin-top:6px;min-height:14px}
`;

export class WorldEditorPanel {
  constructor(cb) {
    this.cb = cb;
    this.el = null;
    this.fileInput = null;
    this.build();
  }

  build() {
    if (typeof document === "undefined") return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    this.style = style;
    this.el = document.createElement("div");
    this.el.className = "wed";
    // cliques no painel não podem "vazar" para o jogo
    for (const type of ["pointerdown", "mousedown", "wheel", "contextmenu"]) {
      this.el.addEventListener(type, e => e.stopPropagation());
    }
    document.body.appendChild(this.el);
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "application/json,.json";
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) this.cb.onImport?.(file);
    });
    this.el.appendChild(this.fileInput);
  }

  setOpen(open) { this.el?.classList.toggle("open", open); }

  btn(label, onClick, { on = false, disabled = false, danger = false, title = "" } = {}) {
    const b = document.createElement("button");
    b.textContent = label;
    if (on) b.classList.add("on");
    if (danger) b.classList.add("danger");
    b.disabled = disabled;
    if (title) b.title = title;
    b.addEventListener("click", () => { onClick(); b.blur(); });
    return b;
  }

  section(title) {
    const h = document.createElement("h4");
    h.textContent = title;
    this.root.appendChild(h);
  }

  line(k, v) {
    const r = document.createElement("div");
    r.className = "row";
    const a = document.createElement("span"), b = document.createElement("span");
    a.textContent = k; b.textContent = v;
    r.append(a, b);
    this.root.appendChild(r);
  }

  render(s) {
    if (!this.el) return;
    const keep = this.el.scrollTop;
    this.el.replaceChildren(this.fileInput);
    this.root = this.el;

    const head = document.createElement("h3");
    head.append(document.createTextNode("World Editor  (F8)"));
    head.appendChild(this.btn("x", () => this.cb.onClose?.(), { title: "Fechar (F8)" }));
    this.root.appendChild(head);

    // modos
    const modes = document.createElement("div");
    for (const m of s.modes) {
      modes.appendChild(this.btn(m.label + (m.enabled ? "" : " (em breve)"), () => this.cb.onMode?.(m.id),
        { on: m.id === s.modeId, disabled: false, title: m.enabled ? "" : m.reason }));
    }
    this.root.appendChild(modes);

    // histórico
    const hist = document.createElement("div");
    hist.appendChild(this.btn("Desfazer", () => this.cb.onUndo?.(), { disabled: !s.canUndo, title: s.undoLabel ? `Ctrl+Z: ${s.undoLabel}` : "Ctrl+Z" }));
    hist.appendChild(this.btn("Refazer", () => this.cb.onRedo?.(), { disabled: !s.canRedo, title: s.redoLabel ? `Ctrl+Y: ${s.redoLabel}` : "Ctrl+Y" }));
    hist.appendChild(this.btn("Fantasmas", () => this.cb.onToggleGhosts?.(), { on: s.showGhosts, title: "Mostrar contorno dos ocultos/removidos (V)" }));
    this.root.appendChild(hist);

    this.section("Seleção");
    const sel = s.selection;
    if (!sel) {
      const m = document.createElement("div");
      m.className = "muted";
      m.textContent = "Clique num elemento. Clique de novo no mesmo ponto (ou Tab) para alternar entre sobrepostos.";
      this.root.appendChild(m);
    } else {
      for (const [k, v] of sel.rows) this.line(k, String(v));
      if (sel.candidates > 1) this.line("sobrepostos", `${sel.index + 1} de ${sel.candidates} (Tab)`);

      if (sel.editable) {
        const act = document.createElement("div");
        act.style.marginTop = "6px";
        act.appendChild(this.btn("Ocultar (H)", () => this.cb.onHide?.(), { disabled: sel.state.hidden || sel.state.removed }));
        act.appendChild(this.btn("Remover (Del)", () => this.cb.onRemove?.(), { danger: true, disabled: sel.state.removed }));
        act.appendChild(this.btn("Restaurar (U)", () => this.cb.onRestore?.(), { disabled: !sel.modified }));
        act.appendChild(this.btn(`Colisão: ${sel.collisionOn ? "ligada" : "desligada"} (T)`, () => this.cb.onToggleCollision?.(), { on: !sel.collisionOn }));
        this.root.appendChild(act);

        if (sel.parts?.length) {
          const parts = document.createElement("div");
          parts.appendChild(document.createTextNode("Editar: "));
          parts.appendChild(this.btn("Tudo", () => this.cb.onPartFocus?.(null), { on: sel.partFocus === null }));
          for (const p of sel.parts) {
            parts.appendChild(this.btn(p === "structure" ? "Estrutura" : "Telhado", () => this.cb.onPartFocus?.(p), { on: sel.partFocus === p }));
          }
          this.root.appendChild(parts);
        }
      } else {
        const m = document.createElement("div");
        m.className = "muted";
        m.textContent = "Lotes só são selecionados para identificar os elementos associados.";
        this.root.appendChild(m);
      }

      if (sel.assoc) {
        this.section("Elementos do lote");
        const list = (title, items) => {
          if (!items.length) return;
          const t = document.createElement("div"); t.className = "muted"; t.textContent = title; this.root.appendChild(t);
          for (const it of items) {
            const d = document.createElement("div");
            d.className = "item";
            const a = document.createElement("span"), b = document.createElement("span");
            a.textContent = it.label; b.textContent = it.state; b.className = "muted";
            d.append(a, b);
            d.addEventListener("click", () => this.cb.onSelectId?.(it.id));
            this.root.appendChild(d);
          }
        };
        list("Construções", sel.assoc.buildings);
        list("Muro", sel.assoc.wall);
        list("Portão", sel.assoc.gate);
        list("Árvores", sel.assoc.trees);
        if (!sel.assoc.buildings.length && !sel.assoc.wall.length && !sel.assoc.gate.length && !sel.assoc.trees.length) {
          this.line("", "nenhum elemento associado carregado");
        }
      }
    }

    this.section(`Modificações (${s.modCount})`);
    if (s.hiddenList.length) {
      for (const it of s.hiddenList.slice(0, 12)) {
        const d = document.createElement("div");
        d.className = "item";
        const a = document.createElement("span"), b = document.createElement("span");
        a.textContent = it.id.length > 30 ? it.id.slice(0, 29) + "…" : it.id;
        a.title = it.id;
        b.textContent = it.label; b.className = "muted";
        d.append(a, b);
        d.addEventListener("click", () => this.cb.onSelectId?.(it.id));
        this.root.appendChild(d);
      }
      if (s.hiddenList.length > 12) this.line("", `… e mais ${s.hiddenList.length - 12}`);
    } else {
      const m = document.createElement("div"); m.className = "muted"; m.textContent = "Nenhuma modificação."; this.root.appendChild(m);
    }
    const io = document.createElement("div");
    io.style.marginTop = "6px";
    io.appendChild(this.btn("Exportar JSON", () => this.cb.onExport?.(), { disabled: !s.modCount }));
    io.appendChild(this.btn("Importar JSON", () => this.fileInput.click()));
    io.appendChild(this.btn("Restaurar tudo", () => this.cb.onClearAll?.(), { danger: true, disabled: !s.modCount }));
    this.root.appendChild(io);

    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = s.message || "";
    this.root.appendChild(msg);
    this.el.scrollTop = keep;
  }

  destroy() {
    this.el?.remove();
    this.style?.remove();
    this.el = null;
  }
}
