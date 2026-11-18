import Phaser from "phaser";
import { loadPreparedMap } from "../data/mapLoader.js";
import WorldChunkManager from "./WorldChunkManager.js";
import {
  toWorld, pointInPolygon
} from "../utils/geometry.js";

const PUBLIC_BASE = import.meta.env.BASE_URL;
const assetUrl = (path) => `${PUBLIC_BASE}${path}`;

const PPM = 16;
const MINIMAP_RANGE_MULTIPLIER = 3;
const MINIMAP_REDRAW_INTERVAL_MS = 100;
const WORLD_EXTENT = 710;
const PLAYER_SPEED = 118;
const PLAYER_RADIUS = 8;

const palette = {
  grass: [0x426b43, 0x4a7448, 0x527b4c, 0x3d6240],
  lot: [0x6c8850, 0x718d53, 0x7a9258, 0x667f4c],
  roof: [0x9b5540, 0xa56c4a, 0x797d78, 0x8d6651],
  commercial: [0x657b83, 0x788b8b, 0x8c8272],
  industrial: [0x777c76, 0x8a8a7b]
};

function clipSegmentToRect(a, b, rect) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [
    a.x - rect.left,
    rect.right - a.x,
    a.y - rect.top,
    rect.bottom - a.y
  ];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }

  return {
    a: { x: a.x + t0 * dx, y: a.y + t0 * dy },
    b: { x: a.x + t1 * dx, y: a.y + t1 * dy }
  };
}

const hash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export default class WorldScene extends Phaser.Scene {
  constructor() {
    super("WorldScene");
    this.mapData = null;
    this.chunkManager = null;
    this.buildingCollision = [];
    this.wallCollision = [];
    this.player = null;
    this.keys = null;
    this.facing = "down";
    this.touch = window.__araControls;
    this.toastUntil = 0;
    this.minimapLastRenderAt = 0;
    this.minimapFocus = null;
    this.v4Preview = new URLSearchParams(window.location.search).get("v4preview") === "1";
    this.performanceMetrics = {
      elapsedMs: 0, frames: 0, fps: 0, averageFps: 0,
      minFps: 0, maxFps: 0, frameMs: 0, maxFrameMs: 0,
      windowElapsedMs: 0, windowFrames: 0, windowMaxFrameMs: 0,
      history: [], collisionChecks: 0, checksPerSecond: 0,
      lastRefresh: 0
    };
  }

  preload() {
    this.load.spritesheet("player", assetUrl("assets/player.png"), {
      frameWidth: 32, frameHeight: 48
    });
    this.load.spritesheet("tiles", assetUrl("assets/tileset.png"), {
      frameWidth: 32, frameHeight: 32
    });

    // Biblioteca V4 do Gemini: modo de prévia, sem substituir os arquivos V2.
    this.load.image("v4-ground-grass", assetUrl("assets/environment/residential-v4-preview/surfaces/01_grama_256x256.png"));
    this.load.image("v4-ground-dirt", assetUrl("assets/environment/residential-v4-preview/surfaces/02_terra_256x256.png"));
    this.load.image("v4-ground-sand", assetUrl("assets/environment/residential-v4-preview/surfaces/03_areia_256x256.png"));
    this.load.image("v4-surface-concrete", assetUrl("assets/environment/residential-v4-preview/surfaces/04_concreto_256x256.png"));
    this.load.image("v4-surface-sidewalk", assetUrl("assets/environment/residential-v4-preview/surfaces/05_calcada_256x256.png"));
    this.load.image("v4-surface-pavers", assetUrl("assets/environment/residential-v4-preview/surfaces/06_pavers_256x256.png"));
    this.load.image("v4-surface-brick", assetUrl("assets/environment/residential-v4-preview/surfaces/07_tijolos_256x256.png"));
    this.load.image("v4-surface-wood", assetUrl("assets/environment/residential-v4-preview/surfaces/08_madeira_256x256.png"));
    this.load.image("v4-roof-ceramic", assetUrl("assets/environment/residential-v4-preview/surfaces/09_telhas_ceramicas_256x256.png"));
    this.load.image("v4-roof-metal", assetUrl("assets/environment/residential-v4-preview/surfaces/10_telhado_metalico_256x256.png"));
    this.load.image("v4-surface-caqui", assetUrl("assets/environment/residential-v4-preview/surfaces/11_pisos_externos_caquinho_256x256.png"));

    // Componentes frontais de muro/portão V4, na mesma perspectiva 3/4 do jogo.
    this.load.image("v4-wall-front", assetUrl("assets/environment/residential-v4-preview/components/09_muro_alto_frente_128x192.png"));
    this.load.image("v4-wall-corner-right", assetUrl("assets/environment/residential-v4-preview/components/10_muro_canto_128x192.png"));
    this.load.image("v4-wall-corner-left", assetUrl("assets/environment/residential-v4-preview/components/17_muro_canto_esquerda_128x192.png"));
    this.load.image("v4-wall-north", assetUrl("assets/environment/residential-v4-preview/components/18_muro_fundo_norte_128x128.png"));
    this.load.image("v4-gate-social", assetUrl("assets/environment/residential-v4-preview/components/08_portao_grade_social_128x192.png"));
    this.load.image("v4-gate-garage", assetUrl("assets/environment/residential-v4-preview/components/07_portao_garagem_basculante_256x192.png"));


    // Revestimentos V3 reaproveitados somente na face dos muros para dar variedade.
    this.load.image("v3-wall-cream", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_cream.png"));
    this.load.image("v3-wall-white", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_white.png"));
    this.load.image("v3-wall-gray", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_gray.png"));
    this.load.image("v3-wall-graphite", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_graphite.png"));
    this.load.image("v3-wall-ochre", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_ochre.png"));
    this.load.image("v3-wall-pink", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_pink.png"));
    this.load.image("v3-wall-teal", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_teal.png"));
    this.load.image("v3-wall-yellow", assetUrl("assets/environment/residential-v4-preview/wall-materials/wall_plaster_yellow.png"));

    this.load.image("grass-ground-v2",
      assetUrl("assets/environment/residential-v2/textures/tiles/grass_tileable.png"));
    this.load.image("roof-terracotta-orange-v2",
      assetUrl("assets/environment/residential-v2/textures/tiles/roof_terracotta_orange_tileable.png"));
    this.load.image("roof-terracotta-shadow-v2",
      assetUrl("assets/environment/residential-v2/textures/tiles/roof_terracotta_shadow_tileable.png"));
    this.load.image("roof-corrugated-gray-v2",
      assetUrl("assets/environment/residential-v2/textures/tiles/roof_corrugated_gray_tileable.png"));
    this.load.image("roof-corrugated-red-v2",
      assetUrl("assets/environment/residential-v2/textures/tiles/roof_corrugated_red_tileable.png"));
    this.load.image("roof-pavers-v2",
      assetUrl("assets/environment/residential-v2/textures/tiles/sidewalk_pavers_tileable.png"));

    // Complete top-down residential compositions. The angled-front references
    // stay out of this scene because the game camera is top-down.
    this.load.image("property-modern-compact-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/modern_compact.png"));
    this.load.image("property-modern-gray-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/modern_gray.png"));
    this.load.image("property-modern-long-pool-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/modern_long_pool.png"));
    this.load.image("property-modern-narrow-flat-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/modern_narrow_flat.png"));
    this.load.image("property-modern-pool-dark-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/modern_pool_dark.png"));
    this.load.image("property-modern-pool-light-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/modern_pool_light.png"));
    this.load.image("property-traditional-red-v2",
      assetUrl("assets/environment/residential-v2/properties/top_down/traditional_red_roof.png"));
  }

  create() {
    this.cameras.main.setBackgroundColor("#3f6b43");
    this.hudObjects = new Set();
    this.hudCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, "HUD");
    this.hudCamera.setScroll(0, 0).setZoom(1).setRoundPixels(true);
    this.hudCamera.inputEnabled = false;
    this.logoText = this.registerHud(this.add.text(0, 0, "ARAÇATEXAS", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "21px",
      color: "#fff1cb", fontStyle: "bold", stroke: "#243329", strokeThickness: 5
    }).setScrollFactor(0).setDepth(1000));

    this.statusText = this.registerHud(this.add.text(0, 0, "Carregando a região...", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "12px",
      color: "#e5e9ce", stroke: "#203027", strokeThickness: 3,
      wordWrap: { width: 420 }
    }).setScrollFactor(0).setDepth(1000));

    this.perfQuickText = this.registerHud(this.add.text(0, 0, "FPS -- · quadro -- ms · F3 análise", {
      fontFamily: "Consolas, monospace", fontSize: "10px",
      color: "#d8e6c5", stroke: "#17241d", strokeThickness: 3
    }).setScrollFactor(0).setDepth(1000));

    this.perfPanelBg = this.registerHud(this.add.rectangle(0, 0, 310, 188, 0x142019, 0.94)
      .setOrigin(0).setScrollFactor(0).setDepth(1090)
      .setStrokeStyle(1, 0xa7b88b, 0.9).setVisible(false));
    this.perfPanelText = this.registerHud(this.add.text(0, 0, "", {
      fontFamily: "Consolas, monospace", fontSize: "10px",
      color: "#e7eddc", lineSpacing: 4,
      padding: { x: 10, y: 8 }
    }).setScrollFactor(0).setDepth(1091).setVisible(false));

    this.toast = this.registerHud(this.add.text(0, 0, "", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "14px",
      color: "#fff8de", backgroundColor: "#24372ee8",
      padding: { x: 12, y: 8 }, stroke: "#111a15", strokeThickness: 2,
      align: "center"
    }).setScrollFactor(0).setDepth(1100).setVisible(false));

    this.input.keyboard?.addCapture(["UP", "DOWN", "LEFT", "RIGHT", "SPACE", "F3"]);
    this.keys = this.input.keyboard?.addKeys(
      "W,A,S,D,UP,DOWN,LEFT,RIGHT,E"
    );
    this.debugKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.F3);

    this.minimapBg = this.registerHud(this.add.rectangle(0, 0, 224, 152, 0x17241d, 0.86)
      .setOrigin(0).setScrollFactor(0).setDepth(1000)
      .setStrokeStyle(2, 0x9ba982, 0.9));
    this.minimapGraphics = this.registerHud(this.add.graphics().setScrollFactor(0).setDepth(1001));
    this.minimapPlayer = this.registerHud(this.add.circle(0, 0, 3, 0xffdf78, 1)
      .setScrollFactor(0).setDepth(1002).setStrokeStyle(1, 0x17241d));

    this.scale.on("resize", this.layoutHud, this);
    this.layoutHud();
    this.loadMap();
  }

  async loadMap() {
    try {
      this.mapData = await loadPreparedMap();
      this.buildWorld();
      this.statusText.setText(
        `Araçatuba Shopping · Avenida Brasília | ${this.mapData.meta.radius_m} m de raio`
      );
      this.layoutHud();
    } catch (error) {
      console.error("[Araçatexas] Não foi possível carregar o mapa:", error);
      this.showSetupMessage(error.message);
    }
  }

  showSetupMessage(reason) {
    const { width, height } = this.scale;
    const panel = this.registerHud(this.add.rectangle(width / 2, height / 2, Math.min(width - 40, 760), 250,
      0x18251e, 0.94).setScrollFactor(0).setDepth(1200)
      .setStrokeStyle(2, 0x9aaa7c));
    const title = this.registerHud(this.add.text(width / 2, height / 2 - 82,
      "MAPA REAL AINDA NÃO PREPARADO", {
        fontFamily: "Trebuchet MS, sans-serif", fontSize: "20px",
        color: "#f2dfaa", fontStyle: "bold", align: "center"
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1201));
    const body = this.registerHud(this.add.text(width / 2, height / 2 - 12,
      `${reason}\n\nNo terminal, dentro da pasta aracatexas-game, execute:\n\nnpm run prepare:map -- --source "C:/Users/guilh/Desktop/python/knoxify-master"\n\nDepois rode: npm run dev`, {
        fontFamily: "Consolas, monospace", fontSize: width < 620 ? "10px" : "13px",
        color: "#e3e9d7", align: "center", lineSpacing: 8,
        wordWrap: { width: Math.min(width - 70, 680) }
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1201));
    this.setupPanel = [panel, title, body];
  }

  buildWorld() {
    const worldPx = WORLD_EXTENT * 2 * PPM;
    this.chunkManager = new WorldChunkManager(this, this.mapData, WORLD_EXTENT);


    this.buildingCollision = this.chunkManager.buildingCollision;
    this.wallCollision = this.chunkManager.wallCollision;
    this.treeCollision = this.chunkManager.treeCollision;

    this.createPlayer();

    this.cameras.main.setBounds(
      -WORLD_EXTENT * PPM, -WORLD_EXTENT * PPM, worldPx, worldPx
    );
    this.cameras.main.startFollow(this.player, true, 0.10, 0.10);
    this.cameras.main.setZoom(this.scale.width < 700 ? 1.0 : 1.12);

    this.drawMinimap();
    this.chunkManager.updateVisible(true);
    this.layoutHud();
    this.syncHudCamera();
  }
  registerHud(object) {
    if (!object) return object;
    object.setScrollFactor(0);
    this.hudObjects?.add(object);
    this.cameras?.main?.ignore(object);
    return object;
  }

  syncHudCamera() {
    if (!this.hudCamera) return;
    const { width, height } = this.scale;
    this.hudCamera.setViewport(0, 0, width, height).setScroll(0, 0).setZoom(1);
    const worldObjects = this.children.list.filter(object => !this.hudObjects.has(object));
    this.hudCamera.ignore(worldObjects);
    this.cameras.main.ignore([...this.hudObjects]);
  }

  createPlayer() {
    this.anims.create({
      key: "walk-down", frames: this.anims.generateFrameNumbers("player", { start: 0, end: 2 }),
      frameRate: 8, repeat: -1
    });
    this.anims.create({
      key: "walk-left", frames: this.anims.generateFrameNumbers("player", { start: 3, end: 5 }),
      frameRate: 8, repeat: -1
    });
    this.anims.create({
      key: "walk-right", frames: this.anims.generateFrameNumbers("player", { start: 6, end: 8 }),
      frameRate: 8, repeat: -1
    });
    this.anims.create({
      key: "walk-up", frames: this.anims.generateFrameNumbers("player", { start: 9, end: 11 }),
      frameRate: 8, repeat: -1
    });

    const spawn = this.mapData.meta.spawn || [0, 0];
    const p = toWorld(spawn, PPM);
    this.player = this.add.sprite(p.x, p.y, "player", 1)
      .setOrigin(0.5, 0.86).setDepth(60);
    this.player.setScale(1);

    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setRoundPixels(true);
  }

  getSafeAreaInsets() {
    const probe = document.getElementById("safe-area-probe");
    if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
    const style = window.getComputedStyle(probe);
    const read = value => Math.max(0, Number.parseFloat(value) || 0);
    return {
      top: read(style.paddingTop),
      right: read(style.paddingRight),
      bottom: read(style.paddingBottom),
      left: read(style.paddingLeft)
    };
  }

  togglePerformancePanel() {
    const visible = !this.perfPanelBg.visible;
    this.perfPanelBg.setVisible(visible);
    this.perfPanelText.setVisible(visible);
    this.layoutHud();
    if (visible) this.refreshPerformancePanel();
  }

  updatePerformance(delta) {
    const metrics = this.performanceMetrics;
    if (!Number.isFinite(delta) || delta <= 0) return;

    metrics.elapsedMs += delta;
    metrics.windowElapsedMs = (metrics.windowElapsedMs || 0) + delta;
    metrics.frames = (metrics.frames || 0) + 1;
    metrics.windowFrames = (metrics.windowFrames || 0) + 1;
    metrics.windowMaxFrameMs = Math.max(metrics.windowMaxFrameMs || 0, delta);

    if (metrics.windowElapsedMs < 500) return;

    const seconds = metrics.windowElapsedMs / 1000;
    metrics.fps = metrics.windowFrames / seconds;
    metrics.frameMs = metrics.windowElapsedMs / metrics.windowFrames;
    metrics.maxFrameMs = metrics.windowMaxFrameMs;
    metrics.checksPerSecond = (metrics.collisionChecks || 0) / seconds;

    metrics.history.push({
      time: metrics.elapsedMs,
      fps: metrics.fps,
      frameMs: metrics.frameMs
    });
    metrics.history = metrics.history.filter(sample =>
      metrics.elapsedMs - sample.time <= 5000
    );

    const fpsValues = metrics.history.map(sample => sample.fps);
    metrics.averageFps = fpsValues.reduce((sum, value) => sum + value, 0) /
      Math.max(1, fpsValues.length);
    metrics.minFps = Math.min(...fpsValues);
    metrics.maxFps = Math.max(...fpsValues);

    metrics.windowElapsedMs = 0;
    metrics.windowFrames = 0;
    metrics.windowMaxFrameMs = 0;
    metrics.collisionChecks = 0;
    metrics.lastRefresh = metrics.elapsedMs;

    const fps = Math.round(metrics.fps);
    const frame = metrics.frameMs.toFixed(1);
    const low = metrics.fps < 30;
    this.perfQuickText.setColor(low ? "#ffb5a5" : "#d8e6c5");
    this.perfQuickText.setText(
      `FPS ${fps} · quadro ${frame} ms · F3 análise`
    );
    if (this.perfPanelBg.visible) this.refreshPerformancePanel();
  }

  refreshPerformancePanel() {
    if (!this.perfPanelText || !this.mapData) return;
    const metrics = this.performanceMetrics;
    const objects = this.children.list;
    const totalObjects = objects.length;
    const activeObjects = objects.filter(object => object.active !== false).length;
    const visibleFlags = objects.filter(object => object.visible !== false).length;
    const graphicsObjects = objects.filter(object => object.type === "Graphics").length;
    const camera = this.cameras.main;
    const view = camera.worldView;
    const counts = this.mapData.meta?.counts || {};
    const buildings = counts.buildings || 0;
    const trees = counts.trees || 0;
    const roads = counts.roads || 0;
    const lots = counts.lots || 0;
    const blocks = counts.blocks || 0;
    const memory = window.performance?.memory?.usedJSHeapSize;
    const memoryLine = memory
      ? `Memória JS: ${(memory / 1048576).toFixed(0)} MB`
      : "Memória JS: não exposta pelo navegador";
    const mapTitle = this.minimapTitle;
    const minimapRange = this.minimapCoverageMeters || { width: 0, height: 0 };
    const hudCamera = this.hudCamera;
    const lines = [
      "ANÁLISE DO JOGO · F3 fecha",
      `FPS atual: ${metrics.fps.toFixed(1)} · média 5s: ${metrics.averageFps.toFixed(1)}`,
      `FPS mín/máx 5s: ${metrics.minFps.toFixed(1)} / ${metrics.maxFps.toFixed(1)}`,
      `Quadro médio/pico: ${metrics.frameMs.toFixed(1)} / ${metrics.maxFrameMs.toFixed(1)} ms`,
      `Objetos: ${totalObjects} total · ${activeObjects} ativos · ${visibleFlags} habilitados`,
      `Graphics: ${graphicsObjects} objetos · chunks ${this.chunkManager?.loaded.size || 0} ativos · ${this.chunkManager?.loadingCount || 0} carregando`,
      `Mapa: ${buildings} edifícios · ${trees} árvores · ${roads} vias`,
      `Terrenos: ${lots} lotes · ${blocks} quadras`,
      `Colisões carregadas: ${this.buildingCollision.length} edifícios · ${this.treeCollision?.length || 0} árvores`,
      `Testes de colisão: ${metrics.checksPerSecond.toFixed(0)} por segundo`,
      `Câmera: zoom ${camera.zoom.toFixed(2)} · viewport ${Math.round(view.width)}×${Math.round(view.height)}`,
      `Minimapa: ${MINIMAP_RANGE_MULTIPLIER}x tela · ${minimapRange.width.toFixed(0)} x ${minimapRange.height.toFixed(0)} m`,
      `Título mapa: ${mapTitle ? `${Math.round(mapTitle.x)},${Math.round(mapTitle.y)} vis=${mapTitle.visible} mask=${mapTitle.cameraFilter}` : "ausente"}`,
      `HUD cam: ${hudCamera ? `${hudCamera.x},${hudCamera.y} ${hudCamera.width}x${hudCamera.height} z=${hudCamera.zoom} id=${hudCamera.id}` : "ausente"}`,
      `Jogador: ${this.player ? `${Math.round(this.player.x)}, ${Math.round(this.player.y)}` : "aguardando"}`,
      memoryLine
    ];
    this.perfPanelText.setText(lines.join("\n"));
  }

  isBlocked(x, y) {
    const samples = [
      { x, y: y + 5 }, { x: x - PLAYER_RADIUS, y: y + 5 },
      { x: x + PLAYER_RADIUS, y: y + 5 }, { x, y: y + 5 - PLAYER_RADIUS }
    ];
    const candidates = this.chunkManager
      ? this.chunkManager.getCollisionCandidates(x, y, PLAYER_RADIUS + 13)
      : new Set([...(this.treeCollision || []), ...(this.buildingCollision || []), ...(this.wallCollision || [])]);

    for (const candidate of candidates) {
      this.performanceMetrics.collisionChecks++;
      if (Number.isFinite(candidate.radius)) {
        if (Phaser.Math.Distance.Between(x, y + 5, candidate.x, candidate.y) <
            PLAYER_RADIUS + candidate.radius) return true;
        continue;
      }
      if (candidate.bounds && (x < candidate.bounds.minX || x > candidate.bounds.maxX ||
          y + 5 < candidate.bounds.minY || y + 5 > candidate.bounds.maxY)) continue;
      if (candidate.segments) {
        const point = { x, y: y + 5 };
        const blocked = candidate.segments.some(segment => {
          const dx = segment.b.x - segment.a.x;
          const dy = segment.b.y - segment.a.y;
          const lengthSq = dx * dx + dy * dy;
          const t = lengthSq > 1e-9
            ? Phaser.Math.Clamp(((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSq, 0, 1)
            : 0;
          const nearestX = segment.a.x + dx * t;
          const nearestY = segment.a.y + dy * t;
          return Phaser.Math.Distance.Between(point.x, point.y, nearestX, nearestY) <
            PLAYER_RADIUS + (candidate.thickness || 4);
        });
        if (blocked) return true;
        continue;
      }
      if (x < candidate.bounds.minX || x > candidate.bounds.maxX ||
          y + 5 < candidate.bounds.minY || y + 5 > candidate.bounds.maxY) continue;
      if (samples.some(point => pointInPolygon(point, candidate.rings))) return true;
    }
    return false;
  }
  update(_time, delta) {
    this.updatePerformance(delta);
    if (this.debugKey && Phaser.Input.Keyboard.JustDown(this.debugKey)) {
      this.togglePerformancePanel();
    }
    if (!this.player || !this.keys) return;
    const touch = window.__araControls || {};
    let dx = (this.keys.D.isDown || this.keys.RIGHT.isDown || touch.right ? 1 : 0) -
             (this.keys.A.isDown || this.keys.LEFT.isDown || touch.left ? 1 : 0);
    let dy = (this.keys.S.isDown || this.keys.DOWN.isDown || touch.down ? 1 : 0) -
             (this.keys.W.isDown || this.keys.UP.isDown || touch.up ? 1 : 0);

    const length = Math.hypot(dx, dy);
    if (length > 0) {
      dx /= length; dy /= length;
      const amount = PLAYER_SPEED * Math.min(delta, 40) / 1000;
      const nextX = this.player.x + dx * amount;
      const nextY = this.player.y + dy * amount;
      if (!this.isBlocked(nextX, this.player.y)) this.player.x = nextX;
      if (!this.isBlocked(this.player.x, nextY)) this.player.y = nextY;

      if (Math.abs(dx) > Math.abs(dy)) this.facing = dx < 0 ? "left" : "right";
      else this.facing = dy < 0 ? "up" : "down";
      this.player.play(`walk-${this.facing}`, true);
    } else {
      this.player.stop();
      const idle = { down: 1, left: 4, right: 7, up: 10 }[this.facing];
      this.player.setFrame(idle);
    }

    const keyboardInteract = Phaser.Input.Keyboard.JustDown(this.keys.E);
    const touchInteract = touch.interact;
    if (keyboardInteract || touchInteract) {
      this.interact();
      if (touchInteract) touch.interact = false;
    }

    this.chunkManager?.updateVisible();
    this.updateMinimapPlayer();
    if (this.toast.visible && this.time.now > this.toastUntil) this.toast.setVisible(false);
  }

  interact() {
    const nearby = this.chunkManager
      ? this.chunkManager.getCollisionCandidates(this.player.x, this.player.y, 82)
      : new Set(this.buildingCollision);
    let closest = null, min = Infinity;
    for (const building of nearby) {
      if (!building.rings) continue;
      const distance = Phaser.Math.Distance.Between(
        this.player.x, this.player.y, building.center.x, building.center.y
      );
      if (distance < min) { min = distance; closest = building; }
    }
    let message = "Você está explorando as ruas de Araçatuba.";
    if (closest && min < 82) {
      const label = closest.name || this.humanBuildingType(closest.buildingType);
      message = "Você está perto de: " + label + ".";
    } else {
      let nearestRoad = null, roadDistance = Infinity;
      const nearbyRoads = this.chunkManager?.getNearbyRoads(
        this.player.x, this.player.y, 120
      ) || [];
      for (const road of nearbyRoads) {
        for (const line of road.lines) {
          for (const world of line) {
            const d = Phaser.Math.Distance.Between(
              this.player.x, this.player.y, world.x, world.y
            );
            if (d < roadDistance) {
              roadDistance = d;
              nearestRoad = road.feature;
            }
          }
        }
      }
      if (nearestRoad && roadDistance < 120) {
        message = "Via próxima: " + nearestRoad.name + ".";
      }
    }
    this.showToast(message);
  }
  humanBuildingType(type) {
    if (/commercial|retail|shop/.test(type)) return "estabelecimento comercial";
    if (/industrial|warehouse/.test(type)) return "edificação industrial";
    if (/apartments|residential/.test(type)) return "edifício residencial";
    return "uma construção";
  }

  showToast(message) {
    const { width, height } = this.scale;
    const safe = this.getSafeAreaInsets();
    const touchUi = window.matchMedia("(pointer: coarse), (max-width: 760px)").matches;
    const bottomOffset = touchUi ? 190 : 26;
    this.toast.setText(message)
      .setPosition(width / 2, height - safe.bottom - bottomOffset)
      .setOrigin(0.5).setVisible(true);
    this.toastUntil = this.time.now + 2400;
  }

  drawMinimap() {
    if (!this.mapData || !this.minimapGraphics || !this.minimapBg) return;

    const { width } = this.scale;
    const safe = this.getSafeAreaInsets();
    const scale = width < 380 ? 0.72 : width < 520 ? 0.80 : width < 760 ? 0.90 : 1;
    const mapWidth = 224 * scale;
    const mapHeight = 152 * scale;
    const visibleWidth = Math.min(width, (window.innerWidth || width) / Math.max(1, window.devicePixelRatio || 1));
    const x0 = Math.max(safe.left + 12, visibleWidth - safe.right - mapWidth - 16);
    const y0 = safe.top + 16;
    const innerX = x0 + 8 * scale;
    const innerY = y0 + 8 * scale;
    const innerWidth = 208 * scale;
    const innerHeight = 116 * scale;
    const centerX = innerX + innerWidth / 2;
    const centerY = innerY + innerHeight / 2;
    const view = this.cameras.main.worldView;
    const focusX = this.player?.x ?? view.centerX;
    const focusY = this.player?.y ?? view.centerY;
    const coverageWidthPx = Math.max(1, view.width * MINIMAP_RANGE_MULTIPLIER);
    const coverageHeightPx = Math.max(1, view.height * MINIMAP_RANGE_MULTIPLIER);

    this.minimapBg.setPosition(x0, y0).setSize(mapWidth, mapHeight);
    this.minimapGraphics.clear();
    this.minimapGraphics.fillStyle(0x26382e, 0.98);
    this.minimapGraphics.fillRect(innerX, innerY, innerWidth, innerHeight);

    // O mapa acompanha o jogador. Cada eixo cobre 3x o que a câmera mostra.
    const mapPoint = p => ({
      x: centerX + ((p[0] * PPM - focusX) / coverageWidthPx) * innerWidth,
      y: centerY + ((-p[1] * PPM - focusY) / coverageHeightPx) * innerHeight
    });
    const clipRect = {
      left: innerX + 1,
      top: innerY + 1,
      right: innerX + innerWidth - 1,
      bottom: innerY + innerHeight - 1
    };

    this.minimapGraphics.lineStyle(Math.max(0.9, 1.15 * scale), 0x9aa58d, 0.88);
    for (const road of this.mapData.roads) {
      for (const line of road.lines) {
        if (line.length < 2) continue;
        for (let i = 1; i < line.length; i++) {
          const segment = clipSegmentToRect(
            mapPoint(line[i - 1]),
            mapPoint(line[i]),
            clipRect
          );
          if (!segment) continue;
          this.minimapGraphics.beginPath();
          this.minimapGraphics.moveTo(segment.a.x, segment.a.y);
          this.minimapGraphics.lineTo(segment.b.x, segment.b.y);
          this.minimapGraphics.strokePath();
        }
      }
    }

    // O retângulo amarelo representa o enquadramento da tela do computador.
    const cameraCenter = mapPoint([
      view.centerX / PPM,
      -view.centerY / PPM
    ]);
    const screenWidth = innerWidth / MINIMAP_RANGE_MULTIPLIER;
    const screenHeight = innerHeight / MINIMAP_RANGE_MULTIPLIER;
    this.minimapGraphics.lineStyle(1.25 * scale, 0xffdf78, 0.95);
    this.minimapGraphics.strokeRect(
      cameraCenter.x - screenWidth / 2,
      cameraCenter.y - screenHeight / 2,
      screenWidth,
      screenHeight
    );

    this.minimapGraphics.lineStyle(1, 0xb0b68e, 0.65);
    this.minimapGraphics.strokeRect(innerX, innerY, innerWidth, innerHeight);
    const playerPoint = mapPoint([focusX / PPM, -focusY / PPM]);
    this.minimapPlayer.setPosition(playerPoint.x, playerPoint.y).setScale(scale);

    this.minimapMapPoint = mapPoint;
    this.minimapFocus = { x: focusX, y: focusY };
    this.minimapCoverageMeters = {
      width: coverageWidthPx / PPM,
      height: coverageHeightPx / PPM
    };
    this.minimapLastRenderAt = this.time.now;

    const titleY = y0 + 130 * scale;
    if (!this.minimapTitle || !this.minimapTitle.active) {
      this.minimapTitle = this.registerHud(this.add.text(
        centerX, titleY, "MINIMAPA · ÁREA 3×",
        {
          fontFamily: "Trebuchet MS, sans-serif",
          fontSize: `${8 * scale}px`,
          color: "#dbe3c6",
          letterSpacing: 1.3 * scale
        }
      ).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1002));
    } else {
      this.minimapTitle
        .setPosition(centerX, titleY)
        .setText("MINIMAPA · ÁREA 3×")
        .setFontSize(`${8 * scale}px`);
    }
  }
  updateMinimapPlayer() {
    if (!this.player) return;
    const now = this.time.now;
    const previous = this.minimapFocus;
    const moved = !previous || Phaser.Math.Distance.Between(
      previous.x, previous.y, this.player.x, this.player.y
    ) >= 8;

    if (!this.minimapMapPoint ||
        (moved && now - this.minimapLastRenderAt >= MINIMAP_REDRAW_INTERVAL_MS)) {
      this.drawMinimap();
    }

    const point = this.minimapMapPoint?.([
      this.player.x / PPM,
      -this.player.y / PPM
    ]);
    if (point) this.minimapPlayer.setPosition(point.x, point.y);
  }
  layoutHud() {
    if (!this.minimapBg) return;
    const { width, height } = this.scale;
    this.hudCamera?.setViewport(0, 0, width, height).setScroll(0, 0).setZoom(1);
    const safe = this.getSafeAreaInsets();
    const left = safe.left + 18;
    const top = safe.top + 14;

    this.logoText?.setPosition(left, top);
    this.statusText?.setPosition(left + 2, top + 31);
    const minimapScale = width < 380 ? 0.72 : width < 520 ? 0.80 : width < 760 ? 0.90 : 1;
    const minimapWidth = 224 * minimapScale;
    const reservedRight = minimapWidth + safe.right + 38;
    const statusWidth = Math.max(120, Math.min(440, width - left - reservedRight));
    this.statusText?.setWordWrapWidth(statusWidth);
    this.statusText?.setFontSize(width < 520 ? "10px" : "12px");
    const statusBottom = top + 31 + (this.statusText?.height || 16);
    const quickY = statusBottom + 7;
    this.perfQuickText?.setPosition(left + 2, quickY);
    this.perfQuickText?.setFontSize(width < 520 ? "9px" : "10px");

    const panelX = left;
    const panelY = quickY + 22;
    const panelWidth = Math.max(180, Math.min(330, width - safe.left - safe.right - 28));
    this.perfPanelBg?.setPosition(panelX, panelY).setSize(panelWidth, 220);
    this.perfPanelText?.setPosition(panelX, panelY);
    this.perfPanelText?.setFontSize(width < 420 ? "9px" : "10px");
    this.perfPanelText?.setWordWrapWidth(Math.max(160, panelWidth - 18));

    if (this.mapData && this.minimapGraphics) this.drawMinimap();
    if (this.toast?.visible) {
      const touchUi = window.matchMedia("(pointer: coarse), (max-width: 760px)").matches;
      this.toast.setPosition(
        width / 2,
        height - safe.bottom - (touchUi ? 190 : 26)
      );
    }
  }
}
