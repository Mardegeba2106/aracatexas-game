import Phaser from "phaser";
import { loadPreparedMap } from "../data/mapLoader.js";
import {
  toWorld, pointInPolygon, polygonBounds, polygonCentroid, getFeaturePolygons
} from "../utils/geometry.js";

const PPM = 16;
const MAP_RADIUS = 650;
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
    this.buildingCollision = [];
    this.player = null;
    this.keys = null;
    this.facing = "down";
    this.touch = window.__araControls;
    this.toastUntil = 0;
  }

  preload() {
    this.load.spritesheet("player", "/assets/player.png", {
      frameWidth: 32, frameHeight: 48
    });
    this.load.spritesheet("tiles", "/assets/tileset.png", {
      frameWidth: 32, frameHeight: 32
    });
  }

  create() {
    this.cameras.main.setBackgroundColor("#3f6b43");
    this.add.text(26, 22, "ARAÇATEXAS", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "21px",
      color: "#fff1cb", fontStyle: "bold", stroke: "#243329", strokeThickness: 5
    }).setScrollFactor(0).setDepth(1000);

    this.statusText = this.add.text(28, 50, "Carregando a região...", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "12px",
      color: "#e5e9ce", stroke: "#203027", strokeThickness: 3
    }).setScrollFactor(0).setDepth(1000);

    this.toast = this.add.text(0, 0, "", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "14px",
      color: "#fff8de", backgroundColor: "#24372ee8",
      padding: { x: 12, y: 8 }, stroke: "#111a15", strokeThickness: 2,
      align: "center"
    }).setScrollFactor(0).setDepth(1100).setVisible(false);

    this.input.keyboard?.addCapture(["UP", "DOWN", "LEFT", "RIGHT", "SPACE"]);
    this.keys = this.input.keyboard?.addKeys(
      "W,A,S,D,UP,DOWN,LEFT,RIGHT,E"
    );

    this.minimapBg = this.add.rectangle(0, 0, 174, 136, 0x17241d, 0.86)
      .setOrigin(0).setScrollFactor(0).setDepth(1000)
      .setStrokeStyle(2, 0x9ba982, 0.9);
    this.minimapGraphics = this.add.graphics().setScrollFactor(0).setDepth(1001);
    this.minimapPlayer = this.add.circle(0, 0, 3, 0xffdf78, 1)
      .setScrollFactor(0).setDepth(1002).setStrokeStyle(1, 0x17241d);

    this.scale.on("resize", this.layoutHud, this);
    this.loadMap();
  }

  async loadMap() {
    try {
      this.mapData = await loadPreparedMap();
      this.buildWorld();
      this.statusText.setText(
        `Araçatuba Shopping · Avenida Brasília   |   ${this.mapData.meta.radius_m} m de raio`
      );
      this.layoutHud();
    } catch (error) {
      console.error("[Araçatexas] Não foi possível carregar o mapa:", error);
      this.showSetupMessage(error.message);
    }
  }

  showSetupMessage(reason) {
    const { width, height } = this.scale;
    const panel = this.add.rectangle(width / 2, height / 2, Math.min(width - 40, 760), 250,
      0x18251e, 0.94).setScrollFactor(0).setDepth(1200)
      .setStrokeStyle(2, 0x9aaa7c);
    const title = this.add.text(width / 2, height / 2 - 82,
      "MAPA REAL AINDA NÃO PREPARADO", {
        fontFamily: "Trebuchet MS, sans-serif", fontSize: "20px",
        color: "#f2dfaa", fontStyle: "bold", align: "center"
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1201);
    const body = this.add.text(width / 2, height / 2 - 12,
      `${reason}\n\nNo terminal, dentro da pasta aracatexas-game, execute:\n\nnpm run prepare:map -- --source "C:/Users/guilh/Desktop/python/knoxify-master"\n\nDepois rode: npm run dev`, {
        fontFamily: "Consolas, monospace", fontSize: width < 620 ? "10px" : "13px",
        color: "#e3e9d7", align: "center", lineSpacing: 8,
        wordWrap: { width: Math.min(width - 70, 680) }
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1201);
    this.setupPanel = [panel, title, body];
  }

  buildWorld() {
    const worldPx = WORLD_EXTENT * 2 * PPM;
    this.add.tileSprite(-WORLD_EXTENT * PPM, -WORLD_EXTENT * PPM,
      worldPx, worldPx, "tiles", 0).setOrigin(0).setDepth(-100);

    this.drawBlocks();
    this.drawLots();
    this.drawRoads();
    this.drawBuildings();
    this.drawTrees();
    this.drawStreetLabels();
    this.createPlayer();
    this.drawMinimap();

    this.cameras.main.setBounds(
      -WORLD_EXTENT * PPM, -WORLD_EXTENT * PPM, worldPx, worldPx
    );
    this.cameras.main.startFollow(this.player, true, 0.10, 0.10);
    this.cameras.main.setZoom(this.scale.width < 700 ? 1.0 : 1.12);
    this.layoutHud();
  }

  drawBlocks() {
    const g = this.add.graphics().setDepth(-30);
    for (const block of this.mapData.blocks) {
      for (const poly of getFeaturePolygons(block, PPM)) {
        if (!poly.length || poly[0].length < 3) continue;
        const outer = poly[0].map(p => new Phaser.Geom.Point(p.x, p.y));
        g.fillStyle(block.zone === "mixed" ? 0x9c956d : 0x87956a, 0.35);
        g.fillPoints(outer, true, true);
        g.lineStyle(2, 0x526b48, 0.26);
        g.strokePoints(outer, true);
      }
    }
  }

  drawLots() {
    const g = this.add.graphics().setDepth(-20);
    for (const lot of this.mapData.lots) {
      for (const poly of getFeaturePolygons(lot, PPM)) {
        if (!poly.length || poly[0].length < 3) continue;
        const ring = poly[0];
        const points = ring.map(p => new Phaser.Geom.Point(p.x, p.y));
        const seed = hash(lot.id);
        const base = palette.lot[seed % palette.lot.length];
        g.fillStyle(base, 0.87);
        g.fillPoints(points, true, true);
        g.lineStyle(1, 0x9eaa68, 0.32);
        g.strokePoints(points, true);
        if (seed % 4 === 0) {
          const c = polygonCentroid(ring);
          g.fillStyle(0xa2ae68, 0.25);
          g.fillRect(c.x - 2, c.y - 2, 4, 4);
        }
      }
    }
  }

  drawRoads() {
    const g = this.add.graphics().setDepth(0);
    for (const road of this.mapData.roads) {
      const width = (road.width_m || 7) * PPM;
      for (const line of road.lines) {
        if (line.length < 2) continue;
        const points = line.map(p => toWorld(p, PPM));
        g.lineStyle(width + 9, 0x8c977e, 0.92);
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
        g.strokePath();

        g.lineStyle(width + 3, 0x39423e, 1);
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
        g.strokePath();

        g.lineStyle(width, 0x515753, 1);
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
        g.strokePath();

        // Asfalto pontilhado em escala de pixel, sem alterar o traçado original da via.
        if (["primary", "secondary", "tertiary"].includes(road.highway)) {
          g.lineStyle(2, 0xc9bd8c, 0.42);
          for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const length = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
            const count = Math.floor(length / 42);
            for (let n = 1; n < count; n += 2) {
              const t = n / count;
              const x = Phaser.Math.Linear(a.x, b.x, t);
              const y = Phaser.Math.Linear(a.y, b.y, t);
              g.fillStyle(0xd8cda5, 0.50);
              g.fillRect(x - 3, y - 1, 6, 2);
            }
          }
        }
      }
    }
  }

  drawBuildings() {
    const g = this.add.graphics().setDepth(30);
    this.buildingCollision = [];
    for (const building of this.mapData.buildings) {
      const type = (building.building_type || "house").toLowerCase();
      for (const poly of getFeaturePolygons(building, PPM)) {
        if (!poly.length || poly[0].length < 3) continue;
        const outer = poly[0];
        const b = polygonBounds(outer);
        const center = polygonCentroid(outer);
        const points = outer.map(p => new Phaser.Geom.Point(p.x, p.y));
        const commercial = /commercial|retail|shop|office/.test(type);
        const industrial = /industrial|warehouse|factory/.test(type);
        const colors = commercial ? palette.commercial :
          industrial ? palette.industrial : palette.roof;
        const shade = colors[hash(building.id) % colors.length];

        // Sombra deslocada e beiral: a geometria segue o footprint real.
        g.fillStyle(0x18231c, 0.38);
        g.fillPoints(outer.map(p => new Phaser.Geom.Point(p.x + 5, p.y + 6)), true, true);
        g.fillStyle(0x4c5148, 1);
        g.fillPoints(outer.map(p => new Phaser.Geom.Point(p.x + 1, p.y + 2)), true, true);
        g.fillStyle(shade, 1);
        g.fillPoints(points, true, true);
        g.lineStyle(2, 0x342f2b, 0.95);
        g.strokePoints(points, true);
        g.lineStyle(1, 0xe0b88a, 0.58);
        g.strokePoints(outer.map(p => new Phaser.Geom.Point(p.x - 1, p.y - 1)), true);

        // Linhas de telhado recortadas ao interior do polígono.
        const spacing = Math.max(9, Math.min(18, Math.floor((b.maxY - b.minY) / 3)));
        for (let y = b.minY + spacing; y < b.maxY - 2; y += spacing) {
          const intersections = [];
          for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
            const a = outer[j], c = outer[i];
            if ((a.y > y) !== (c.y > y)) {
              intersections.push(a.x + (c.x - a.x) * (y - a.y) / (c.y - a.y));
            }
          }
          intersections.sort((a, c) => a - c);
          g.lineStyle(1, commercial ? 0xc4d1ca : 0x3e302d, 0.27);
          for (let i = 0; i + 1 < intersections.length; i += 2) {
            g.beginPath();
            g.moveTo(intersections[i] + 2, y);
            g.lineTo(intersections[i + 1] - 2, y);
            g.strokePath();
          }
        }

        // Pequena área clara representa uma claraboia ou detalhe de fachada.
        const w = Math.max(3, Math.min(9, (b.maxX - b.minX) * 0.18));
        const h = Math.max(2, Math.min(5, (b.maxY - b.minY) * 0.12));
        g.fillStyle(commercial ? 0xb4c6bb : 0xd9ad7b, 0.72);
        g.fillRect(center.x - w / 2, center.y - h / 2, w, h);

        this.buildingCollision.push({
          rings: poly,
          bounds: { minX: b.minX - PLAYER_RADIUS, minY: b.minY - PLAYER_RADIUS,
            maxX: b.maxX + PLAYER_RADIUS, maxY: b.maxY + PLAYER_RADIUS },
          name: building.name || "",
          buildingType: type,
          center
        });
      }
    }
  }

  drawTrees() {
    this.treeCollision = [];
    const g = this.add.graphics().setDepth(45);
    for (const tree of (this.mapData.trees || [])) {
      const p = toWorld(tree.point, PPM);
      const seed = hash(tree.id);
      const radius = 10 + (seed % 5);
      g.fillStyle(0x1d2d21, 0.48);
      g.fillEllipse(p.x + 3, p.y + 7, radius * 2.3, radius * 1.25);
      g.fillStyle(0x654a30, 1);
      g.fillRect(p.x - 2, p.y + 2, 4, 12);
      g.fillStyle(seed % 2 ? 0x315d38 : 0x386c3e, 1);
      g.fillCircle(p.x, p.y - 4, radius);
      g.fillStyle(0x60904e, 0.9);
      g.fillCircle(p.x - 4, p.y - 7, Math.max(4, radius * 0.55));
      g.fillStyle(0x87a65c, 0.68);
      g.fillRect(p.x - 4, p.y - 12, 4, 3);
      this.treeCollision.push({ x: p.x, y: p.y + 3, radius: 11 });
    }
  }

  drawStreetLabels() {
    let drawn = 0;
    for (const road of this.mapData.roads) {
      if (!road.name || drawn > 36) continue;
      const line = road.lines.find(candidate => candidate.length > 2);
      if (!line) continue;
      const middle = line[Math.floor(line.length / 2)];
      const p = toWorld(middle, PPM);
      const label = this.add.text(p.x, p.y - 10, road.name, {
        fontFamily: "Trebuchet MS, sans-serif", fontSize: "10px",
        color: "#eee3ba", stroke: "#252e2a", strokeThickness: 3,
        backgroundColor: "#303b35a0", padding: { x: 3, y: 1 }
      }).setOrigin(0.5).setDepth(10).setAlpha(0.78);
      drawn++;
    }
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

  isBlocked(x, y) {
    const samples = [
      { x, y: y + 5 }, { x: x - PLAYER_RADIUS, y: y + 5 },
      { x: x + PLAYER_RADIUS, y: y + 5 }, { x, y: y + 5 - PLAYER_RADIUS }
    ];
    for (const tree of (this.treeCollision || [])) {
      if (Phaser.Math.Distance.Between(x, y + 5, tree.x, tree.y) <
          PLAYER_RADIUS + tree.radius) return true;
    }
    for (const building of this.buildingCollision) {
      if (x < building.bounds.minX || x > building.bounds.maxX ||
          y + 5 < building.bounds.minY || y + 5 > building.bounds.maxY) continue;
      if (samples.some(point => pointInPolygon(point, building.rings))) return true;
    }
    return false;
  }

  update(_time, delta) {
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

    this.updateMinimapPlayer();
    if (this.toast.visible && this.time.now > this.toastUntil) this.toast.setVisible(false);
  }

  interact() {
    const playerMeter = {
      x: this.player.x / PPM,
      y: -this.player.y / PPM
    };
    let closest = null, min = Infinity;
    for (const building of this.buildingCollision) {
      const distance = Phaser.Math.Distance.Between(
        this.player.x, this.player.y, building.center.x, building.center.y
      );
      if (distance < min) { min = distance; closest = building; }
    }
    let message = "Você está explorando as ruas de Araçatuba.";
    if (closest && min < 82) {
      const label = closest.name || this.humanBuildingType(closest.buildingType);
      message = `Você está perto de: ${label}.`;
    } else {
      let nearestRoad = null, roadDistance = Infinity;
      for (const road of this.mapData.roads) {
        if (!road.name) continue;
        for (const line of road.lines) {
          for (const p of line) {
            const world = toWorld(p, PPM);
            const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, world.x, world.y);
            if (d < roadDistance) { roadDistance = d; nearestRoad = road; }
          }
        }
      }
      if (nearestRoad && roadDistance < 120) message = `Via próxima: ${nearestRoad.name}.`;
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
    this.toast.setText(message).setPosition(width / 2, height - 112)
      .setOrigin(0.5).setVisible(true);
    this.toastUntil = this.time.now + 2400;
  }

  drawMinimap() {
    this.minimapGraphics.clear();
    const x0 = this.scale.width - 190, y0 = 16;
    this.minimapBg.setPosition(x0, y0);
    this.minimapGraphics.fillStyle(0x26382e, 0.98);
    this.minimapGraphics.fillRect(x0 + 9, y0 + 9, 156, 112);
    const mapPoint = p => ({
      x: x0 + 87 + (p[0] / MAP_RADIUS) * 74,
      y: y0 + 65 - (p[1] / MAP_RADIUS) * 52
    });
    this.minimapGraphics.lineStyle(1, 0x7f8b76, 0.75);
    for (const road of this.mapData.roads) {
      for (const line of road.lines) {
        if (line.length < 2) continue;
        const first = mapPoint(line[0]);
        this.minimapGraphics.beginPath();
        this.minimapGraphics.moveTo(first.x, first.y);
        for (let i = 1; i < line.length; i++) {
          const p = mapPoint(line[i]);
          this.minimapGraphics.lineTo(p.x, p.y);
        }
        this.minimapGraphics.strokePath();
      }
    }
    this.minimapGraphics.lineStyle(1, 0xb0b68e, 0.5);
    this.minimapGraphics.strokeRect(x0 + 9, y0 + 9, 156, 112);
    this.minimapPlayer.setPosition(x0 + 87, y0 + 65);
    this.minimapMapPoint = mapPoint;
    this.minimapTitle?.destroy();
    this.minimapTitle = this.add.text(x0 + 87, y0 + 123, "MINIMAPA", {
      fontFamily: "Trebuchet MS, sans-serif", fontSize: "8px",
      color: "#dbe3c6", letterSpacing: 2
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1002);
  }

  updateMinimapPlayer() {
    if (!this.minimapMapPoint || !this.player) return;
    const p = this.minimapMapPoint([
      this.player.x / PPM, -this.player.y / PPM
    ]);
    this.minimapPlayer.setPosition(p.x, p.y);
  }

  layoutHud() {
    if (!this.minimapBg) return;
    const { width } = this.scale;
    const x = width - 190;
    this.minimapBg.setPosition(x, 16);
    // Elementos do mapa são reposicionados no redraw após o carregamento.
    if (this.mapData && this.minimapGraphics) this.drawMinimap();
    if (this.toast?.visible) this.toast.setX(width / 2);
  }
}
