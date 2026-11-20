// Dev Mode: câmera livre para inspecionar o mapa sem mover o personagem.
//
// Só é carregada em desenvolvimento: WorldScene a importa dentro de
// `if (import.meta.env.DEV)`, então o Vite não a inclui no build de produção.
//
// REGRA: esta câmera só desloca o enquadramento e muda a escala (zoom).
// Não mexe em rotação, inclinação, sprites nem na renderização.
//
// Não importa o Phaser de propósito: assim a lógica roda em Node com mocks
// (scripts/test_free_camera.mjs).

const KEYCODES = {
  F6: 117, SHIFT: 16,
  W: 87, A: 65, S: 83, D: 68,
  PLUS: 187, MINUS: 189, NUM_ADD: 107, NUM_SUB: 109,
  ZERO: 48, NUM_ZERO: 96,
  COMMA: 188, PERIOD: 190
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const FREE_CAMERA_DEFAULTS = {
  baseSpeed: 700,      // px de tela por segundo com zoom 1 (a velocidade no mundo divide pelo zoom)
  minSpeed: 100,
  maxSpeed: 8000,
  shiftBoost: 3.5,     // multiplicador enquanto Shift está pressionado
  speedStep: 1.25,     // , diminui e . aumenta a velocidade
  wheelStep: 1.15,     // fator de zoom por "clique" do scroll
  keyZoomRate: 2.2,    // zoom contínuo com + e -: dobra a cada ~0,9 s
  // Limites do zoom. Afastar muito carrega muitos chunks de uma vez (a janela de
  // chunks acompanha a câmera), então o mínimo é conservador.
  minZoom: 0.2,
  maxZoom: 4,
  returnMs: 650,       // duração mínima do retorno suave até o personagem
  returnMaxMs: 1800,   // a duração cresce com a distância, até este máximo
  pixelsPerMeter: 16,
  bounds: null         // {x, y, width, height} a restaurar ao sair (limites do mundo)
};

export class FreeCamera {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.cfg = { ...FREE_CAMERA_DEFAULTS, ...options };
    this.active = false;
    this.returning = false;
    this.speed = this.cfg.baseSpeed;
    this.savedZoom = null;
    // Posição própria em ponto flutuante: com roundPixels o Phaser faz Math.floor no
    // scroll a cada quadro, o que travaria passos menores que 1 px (velocidade baixa).
    this.fx = 0;
    this.fy = 0;
    this.hudText = "";
    this._prev = {};

    const keyboard = scene.input?.keyboard;
    this.keys = {};
    if (keyboard) {
      // Só o F6 é capturado (o navegador usa F6 para a barra de endereço).
      // As demais teclas não são capturadas para não bloquear atalhos como Ctrl +/-.
      keyboard.addCapture?.("F6");
      for (const [name, code] of Object.entries(KEYCODES)) {
        this.keys[name] = keyboard.addKey(code, false);
      }
    }

    // Atalhos por EVENTO da tecla (nao por polling): um toque curto entre dois quadros
    // (FPS baixo) ainda conta. Sem eventos (testes com mocks) cai no polling em update().
    this.pending = { reset: false, slower: false, faster: false };
    const all = Object.values(this.keys);
    this.eventDriven = all.length > 0 && all.every(k => typeof k.on === "function");
    if (this.eventDriven) {
      this.keys.F6.on("down", () => this.toggle());
      const reset = () => { this.pending.reset = true; };
      this.keys.ZERO.on("down", reset);
      this.keys.NUM_ZERO.on("down", reset);
      this.keys.COMMA.on("down", () => { this.pending.slower = true; });
      this.keys.PERIOD.on("down", () => { this.pending.faster = true; });
    }

    this.onWheel = this.onWheel.bind(this);
    this.layout = this.layout.bind(this);
    scene.input?.on?.("wheel", this.onWheel);
    scene.scale?.on?.("resize", this.layout);
    scene.events?.once?.("shutdown", () => this.destroy());

    this.createHud();
    this.refreshHud(true);
  }

  get camera() { return this.scene.cameras.main; }

  // O personagem não deve responder ao teclado enquanto a câmera livre está
  // ativa nem durante o retorno suave.
  get blocksPlayer() { return this.active || this.returning; }

  // ---------------------------------------------------------------- estados
  toggle() {
    if (this.returning) return;
    if (this.active) this.disable();
    else this.enable();
  }

  enable() {
    const cam = this.camera;
    this.savedZoom = cam.zoom;
    cam.stopFollow();
    cam.removeBounds();                 // permite percorrer o mapa inteiro
    this.fx = cam.scrollX;
    this.fy = cam.scrollY;
    this.active = true;
    this.scene.player?.anims?.stop?.(); // o personagem fica parado onde estava
    this.refreshHud(true);
  }

  disable() {
    const cam = this.camera;
    const player = this.scene.player;
    this.active = false;
    this.returning = true;
    this.refreshHud(true);

    const finish = () => {
      if (this.cfg.bounds) {
        const b = this.cfg.bounds;
        cam.setBounds(b.x, b.y, b.width, b.height);
      }
      if (player) cam.startFollow(player, true, 0.12, 0.12);
      this.returning = false;
      this.refreshHud(true);
    };

    if (!player) { finish(); return; }
    // Volta com pan + zoom suaves (sem teletransporte e sem tocar na perspectiva).
    // Quanto mais longe a câmera estiver, mais longa a viagem, para não voar rápido demais.
    const distance = Math.hypot(player.x - (this.fx + cam.width / 2), player.y - (this.fy + cam.height / 2));
    const ms = clamp(this.cfg.returnMs + distance * 0.1, this.cfg.returnMs, this.cfg.returnMaxMs);
    cam.zoomTo(this.savedZoom ?? cam.zoom, ms, "Sine.easeInOut", true);
    cam.pan(player.x, player.y, ms, "Sine.easeInOut", true,
      (_camera, progress) => { if (progress >= 1) finish(); });
  }

  // Se algo externo mexeu na câmera (diferença maior que o arredondamento do Phaser), adota a posição dela.
  syncFromCamera() {
    const cam = this.camera;
    if (Math.abs(cam.scrollX - this.fx) >= 1.5 || Math.abs(cam.scrollY - this.fy) >= 1.5) {
      this.fx = cam.scrollX;
      this.fy = cam.scrollY;
    }
  }

  // ------------------------------------------------------------------- zoom
  // Muda só a escala, mantendo fixo o ponto do mundo sob (sx, sy) da tela.
  zoomAt(nextZoom, sx, sy) {
    const cam = this.camera;
    const z0 = cam.zoom;
    const z1 = clamp(nextZoom, this.cfg.minZoom, this.cfg.maxZoom);
    if (z1 === z0) return;
    this.syncFromCamera();
    const w = cam.width, h = cam.height;
    const wx = this.fx + w / 2 - w / (2 * z0) + sx / z0;
    const wy = this.fy + h / 2 - h / (2 * z0) + sy / z0;
    cam.setZoom(z1);
    this.fx = wx - w / 2 + w / (2 * z1) - sx / z1;
    this.fy = wy - h / 2 + h / (2 * z1) - sy / z1;
    cam.scrollX = this.fx;
    cam.scrollY = this.fy;
  }

  onWheel(pointer, _over, _dx, dy) {
    if (!this.active || !dy) return;
    const factor = dy < 0 ? this.cfg.wheelStep : 1 / this.cfg.wheelStep;
    this.zoomAt(this.camera.zoom * factor, pointer.x, pointer.y);
  }

  // ----------------------------------------------------------------- update
  justPressed(name) {
    const down = this.keys[name]?.isDown === true;
    const was = this._prev[name] === true;
    this._prev[name] = down;
    return down && !was;
  }

  update(deltaMs) {
    let resetPressed, slower, faster;
    if (this.eventDriven) {
      ({ reset: resetPressed, slower, faster } = this.pending);
      this.pending.reset = this.pending.slower = this.pending.faster = false;
    } else {
      if (this.justPressed("F6")) this.toggle();
      resetPressed = this.justPressed("ZERO") || this.justPressed("NUM_ZERO");
      slower = this.justPressed("COMMA");
      faster = this.justPressed("PERIOD");
    }

    if (this.active) {
      const cam = this.camera;
      this.syncFromCamera();
      const dt = Math.min(deltaMs, 50) / 1000;
      const k = this.keys;
      let dx = (k.D?.isDown ? 1 : 0) - (k.A?.isDown ? 1 : 0);
      let dy = (k.S?.isDown ? 1 : 0) - (k.W?.isDown ? 1 : 0);
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx /= len; dy /= len;                       // diagonal sem ficar mais rápida
        const boost = k.SHIFT?.isDown ? this.cfg.shiftBoost : 1;
        const step = (this.speed * boost / cam.zoom) * dt;
        this.fx += dx * step;
        this.fy += dy * step;
        cam.scrollX = this.fx;
        cam.scrollY = this.fy;
      }

      if (slower) this.speed = clamp(this.speed / this.cfg.speedStep, this.cfg.minSpeed, this.cfg.maxSpeed);
      if (faster) this.speed = clamp(this.speed * this.cfg.speedStep, this.cfg.minSpeed, this.cfg.maxSpeed);

      const zoomIn = k.PLUS?.isDown || k.NUM_ADD?.isDown;
      const zoomOut = k.MINUS?.isDown || k.NUM_SUB?.isDown;
      if (zoomIn !== zoomOut) {
        const factor = Math.pow(this.cfg.keyZoomRate, (zoomIn ? 1 : -1) * dt);
        this.zoomAt(cam.zoom * factor, cam.width / 2, cam.height / 2);
      }
      if (resetPressed && this.savedZoom) this.zoomAt(this.savedZoom, cam.width / 2, cam.height / 2);
    }
    this.refreshHud();
  }

  // -------------------------------------------------------------------- HUD
  createHud() {
    const scene = this.scene;
    if (!scene.add || !scene.registerHud) return;
    this.hudBg = scene.registerHud(scene.add.rectangle(0, 0, 10, 10, 0x0e1a14, 0.78)
      .setOrigin(0, 1).setDepth(1200));
    this.hudLabel = scene.registerHud(scene.add.text(0, 0, "", {
      fontFamily: "Consolas, monospace", fontSize: "11px",
      color: "#d8e6c5", stroke: "#0e1a14", strokeThickness: 2, lineSpacing: 2
    }).setOrigin(0, 1).setDepth(1201));
    this.layout();
  }

  layout() {
    if (!this.hudLabel) return;
    const { width = 0, height = 0 } = this.scene.scale || {};
    const mm = this.scene.minimapBg;
    let left = 10;
    if (mm && mm.x < width / 2 && mm.y > height / 2) left = mm.x + (mm.radius || 82) + 14;
    this.hudLabel.setPosition(left + 6, height - 14);
    this.hudBg.setPosition(left, height - 8);
    this.fitBackground();
  }

  fitBackground() {
    if (!this.hudBg || !this.hudLabel) return;
    this.hudBg.setSize(this.hudLabel.width + 14, this.hudLabel.height + 12);
  }

  buildHudText() {
    if (this.returning) return "CÂMERA LIVRE: RETORNANDO AO PERSONAGEM...";
    if (!this.active) return "CÂMERA LIVRE: DESATIVADA   (F6)";
    const cam = this.camera;
    const ppm = this.cfg.pixelsPerMeter;
    const cx = this.fx + cam.width / 2;
    const cy = this.fy + cam.height / 2;
    return [
      "CÂMERA LIVRE: ATIVA",
      `Zoom ${cam.zoom.toFixed(2)}x   X ${(cx / ppm).toFixed(1)} m   Y ${(-cy / ppm).toFixed(1)} m`,
      `Velocidade ${Math.round(this.speed)} px/s   (Shift x${this.cfg.shiftBoost})`,
      "WASD mover  |  Shift acelera  |  scroll ou + - zoom  |  0 zoom padrão",
      ",  .  velocidade  |  F6 sair"
    ].join("\n");
  }

  refreshHud(force = false) {
    const text = this.buildHudText();
    if (!force && text === this.hudText) return;
    this.hudText = text;
    if (!this.hudLabel) return;
    this.hudLabel.setText(text);
    this.fitBackground();
  }

  destroy() {
    this.scene.input?.off?.("wheel", this.onWheel);
    this.scene.scale?.off?.("resize", this.layout);
    this.hudBg?.destroy?.();
    this.hudLabel?.destroy?.();
  }
}
