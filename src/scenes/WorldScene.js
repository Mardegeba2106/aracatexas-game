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

const distanceToSegment = (point, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  )) : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
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
    this.wallCollision = new Map();
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
    // Atlas oficial do Araçatexas: 8 colunas x 4 linhas, tiles de 32 px.
    this.load.spritesheet("ara-tiles", "/assets/aracatexas_tileset.png", {
      frameWidth: 32, frameHeight: 32
    });
    // Prefabs oficiais: 4 colunas x 2 linhas, células de 64 px.
    this.load.spritesheet("ara-buildings", "/assets/aracatexas_buildings.png", {
      frameWidth: 64, frameHeight: 64
    });
  }

  create() {
    this.cameras.main.setBackgroundColor("#3f5b39");
    this.titleText = this.add.text(26, 22, "ARAÇATEXAS", {
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
    // Elementos pequenos do atlas são criados uma vez e reutilizados.
    this.createAtlasTexture("ara-tree", 26);
    this.createAtlasTexture("ara-shrub", 27);
    this.createResidentialTextures();
    // Fundo de grama sólido por enquanto: evita repetir o atlas inteiro como padrão.

    // Lotes já definem o solo; evita sobrepor os limites de quadra em toda a tela.
    this.drawLots();
    this.drawRoads();
    this.drawBuildings();
    this.drawResidentialProperties();
    this.drawTrees();
    this.drawStreetLabels();
    this.createPlayer();
    this.drawMinimap();
    console.info(
      `[Araçatexas] Mundo renderizado: ${this.buildingCollision.length} construções, ${this.residentialPropertyCount} propriedades residenciais, ${this.treeCollision.length} árvores.`
    );

    this.cameras.main.setBounds(
      -WORLD_EXTENT * PPM, -WORLD_EXTENT * PPM, worldPx, worldPx
    );
    this.cameras.main.startFollow(this.player, true, 0.10, 0.10);
    this.cameras.main.setZoom(this.scale.width < 700 ? 0.62 : 0.50);
    this.layoutHud();
  }

  createAtlasTexture(key, frameIndex) {
    if (this.textures.exists(key)) return;
    const atlas = this.textures.get("ara-tiles");
    const frame = this.textures.getFrame("ara-tiles", frameIndex);
    const source = atlas.getSourceImage();
    const texture = this.textures.createCanvas(key, frame.cutWidth, frame.cutHeight);
    texture.getContext().drawImage(
      source,
      frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight,
      0, 0, frame.cutWidth, frame.cutHeight
    );
    texture.refresh();
  }

  drawBlocks() {
    const g = this.add.graphics().setDepth(-40);
    for (const block of this.mapData.blocks) {
      for (const poly of getFeaturePolygons(block, PPM)) {
        if (!poly.length || poly[0].length < 3) continue;
        const outer = poly[0].map(p => new Phaser.Geom.Point(p.x, p.y));
        g.fillStyle(block.zone === "mixed" ? 0x9c956d : 0x87956a, 0.10);
        g.fillPoints(outer, true, true);
        g.lineStyle(2, 0x526b48, 0.18);
        g.strokePoints(outer, true);
      }
    }
  }


  createResidentialTextures() {
    const create = (key, painter) => {
      if (this.textures.exists(key)) return;
      const texture = this.textures.createCanvas(key, 32, 32);
      const context = texture.getContext();
      context.imageSmoothingEnabled = false;
      painter(context);
      texture.refresh();
    };

    create("res-yard-grass", ctx => {
      ctx.fillStyle = "#557b43"; ctx.fillRect(0, 0, 32, 32);
      for (let i = 0; i < 42; i++) {
        const x = (i * 17 + 5) % 32, y = (i * 23 + 3) % 32;
        ctx.fillStyle = i % 3 === 0 ? "#78965a" : "#496d3c";
        ctx.fillRect(x, y, 1, 1);
      }
    });
    create("res-yard-garden", ctx => {
      ctx.fillStyle = "#527548"; ctx.fillRect(0, 0, 32, 32);
      for (let i = 0; i < 20; i++) {
        const x = (i * 13 + 4) % 30, y = (i * 19 + 5) % 30;
        ctx.fillStyle = i % 2 ? "#8ca95e" : "#365f3c";
        ctx.fillRect(x, y, 2, 2);
        if (i % 4 === 0) {
          ctx.fillStyle = "#c4b66e";
          ctx.fillRect(x + 1, y - 1, 1, 1);
        }
      }
    });
    create("res-yard-dirt", ctx => {
      ctx.fillStyle = "#806b4c"; ctx.fillRect(0, 0, 32, 32);
      for (let i = 0; i < 34; i++) {
        const x = (i * 11 + 7) % 32, y = (i * 19 + 2) % 32;
        ctx.fillStyle = i % 2 ? "#a58a61" : "#67573f";
        ctx.fillRect(x, y, 2, 1);
      }
    });
    create("res-driveway-concrete", ctx => {
      ctx.fillStyle = "#8c8d82"; ctx.fillRect(0, 0, 32, 32);
      for (let y = 0; y < 32; y += 8) {
        ctx.fillStyle = "#777b73"; ctx.fillRect(0, y, 32, 1);
      }
      for (let i = 0; i < 18; i++) {
        const x = (i * 17 + 3) % 32, y = (i * 7 + 9) % 32;
        ctx.fillStyle = "#a6a595"; ctx.fillRect(x, y, 1, 1);
      }
    });
    create("res-driveway-pavers", ctx => {
      ctx.fillStyle = "#9a9581"; ctx.fillRect(0, 0, 32, 32);
      for (let y = 0; y < 32; y += 8) {
        ctx.fillStyle = "#6f7068"; ctx.fillRect(0, y, 32, 1);
        for (let x = y % 16 ? 0 : 8; x < 32; x += 16) {
          ctx.fillRect(x, y, 1, 8);
        }
      }
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = "#b1aa91";
        ctx.fillRect((i * 7 + 2) % 32, (i * 13 + 1) % 32, 2, 1);
      }
    });
    create("res-garage-roof", ctx => {
      ctx.fillStyle = "#79513f"; ctx.fillRect(0, 0, 32, 32);
      for (let y = 3; y < 32; y += 6) {
        ctx.fillStyle = "#573e35"; ctx.fillRect(0, y, 32, 1);
        ctx.fillStyle = "#9c6c4d"; ctx.fillRect(0, y + 1, 32, 1);
      }
      ctx.fillStyle = "#b07d59"; ctx.fillRect(3, 3, 2, 2);
      ctx.fillRect(20, 15, 2, 2);
    });
  }

  drawResidentialSurface(textureKey, points, depth) {
    if (!points || points.length < 3) return;
    const bounds = polygonBounds(points);
    const width = Math.max(2, bounds.maxX - bounds.minX);
    const height = Math.max(2, bounds.maxY - bounds.minY);
    const maskShape = this.make.graphics({ x: 0, y: 0, add: false });
    maskShape.fillStyle(0xffffff, 1);
    maskShape.fillPoints(points, true, true);
    this.residentialMasks ||= [];
    this.residentialMasks.push(maskShape);
    this.add.tileSprite(
      bounds.minX, bounds.minY, width, height, textureKey
    )
      .setOrigin(0)
      .setTileScale(1, 1)
      .setMask(maskShape.createGeometryMask())
      .setDepth(depth);
  }


  drawLots() {
    const g = this.add.graphics().setDepth(-20);
    const groundTiles = [0, 1, 2, 3, 5];

    for (const lot of this.mapData.lots) {
      const zone = String(lot.zone || "").toLowerCase();
      const commercial = /commercial|industrial|retail/.test(zone);
      const seed = hash(lot.id);
      const base = commercial
        ? [0x807d5a, 0x8b825e, 0x797d60][seed % 3]
        : palette.lot[seed % palette.lot.length];

      for (const poly of getFeaturePolygons(lot, PPM)) {
        if (!poly.length || poly[0].length < 3) continue;
        const ring = poly[0];
        const points = ring.map(p => new Phaser.Geom.Point(p.x, p.y));
        g.fillStyle(base, 0.96);
        g.fillPoints(points, true, true);
        g.lineStyle(1, commercial ? 0xb8a779 : 0xa2ad76, 0.42);
        g.strokePoints(points, true);

        // Pequenos detalhes de chão do atlas, sem criar uma textura do tamanho
        // do mapa inteiro. Um elemento por lote mantém a cena leve.
        const center = polygonCentroid(ring);
        if (seed % 7 === 0) {
          const tile = commercial ? 30 : groundTiles[seed % groundTiles.length];
          this.add.image(center.x, center.y, "ara-tiles", tile)
            .setScale(commercial ? 1.25 : 1.45)
            .setAlpha(0.48)
            .setDepth(-19);
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

        // Camadas de calçada, meio-fio e asfalto seguem o traçado real.
        // Usamos traços vetoriais contínuos para evitar centenas de TileSprites
        // separados, que pesavam desnecessariamente na renderização.
        g.lineStyle(width + 24, 0x777f6c, 1);
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
        g.strokePath();

        g.lineStyle(width + 16, 0xb6ad91, 1);
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
        g.strokePath();

        g.lineStyle(width + 9, 0x8c977e, 0.98);
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

        // Faixas centrais alinhadas à direção real da via.
        if (["primary", "secondary", "tertiary"].includes(road.highway)) {
          const major = ["primary", "secondary"].includes(road.highway);
          const dashLength = major ? 24 : 16;
          const gapLength = major ? 20 : 22;
          g.lineStyle(major ? 4 : 3, major ? 0xe4cf8d : 0xd7d1b9, major ? 0.82 : 0.68);

          for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const length = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
            const angle = Phaser.Math.Angle.Between(a.x, a.y, b.x, b.y);
            const dx = Math.cos(angle), dy = Math.sin(angle);

            for (let start = 8; start < length - 4; start += dashLength + gapLength) {
              const end = Math.min(length - 3, start + dashLength);
              g.lineBetween(
                a.x + dx * start, a.y + dy * start,
                a.x + dx * end, a.y + dy * end
              );
            }
          }
        }
      }
    }
  }

  drawBuildings() {
    const shadows = this.add.graphics().setDepth(27);
    const roofs = this.add.graphics().setDepth(29);
    const details = this.add.graphics().setDepth(30);
    this.buildingCollision = [];

    for (const building of this.mapData.buildings) {
      const type = String(building.building_type || "house").toLowerCase();
      const style = building.visual_style || {};
      const variant = Number.isFinite(style.variant)
        ? style.variant : hash(building.id) % 4;
      const namedCommercial = /shopping|habib|mcdonald|burger|posto|supermercado|restaurante|loja|atacad/i
        .test(building.name || "");
      const commercial = /commercial|retail|shop|office/.test(type) ||
        style.category === "commercial" || namedCommercial;
      const industrial = /industrial|warehouse|factory/.test(type);
      const institutional = /apartment|apartments|hotel|school|transportation/.test(type);
      const colors = commercial
        ? palette.commercial
        : industrial ? palette.industrial : palette.roof;

      for (const poly of getFeaturePolygons(building, PPM)) {
        if (!poly.length || poly[0].length < 3) continue;
        const outer = poly[0];
        const bounds = polygonBounds(outer);
        const polygonCenter = polygonCentroid(outer);
        // Polígonos grandes e côncavos (como o shopping) podem ter o centroide
        // deslocado para fora da área. Para landmarks, o centro da caixa é mais
        // estável para posicionar fachada, prefab e letreiro.
        const center = (building.area_m2 || 0) > 1500
          ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
          : polygonCenter;
        const points = outer.map(p => new Phaser.Geom.Point(p.x, p.y));
        const shade = colors[hash(building.id) % colors.length];

        // O footprint continua exato. A textura aparece como detalhe pequeno,
        // evitando máscaras gigantes que estouram a memória do Canvas.
        shadows.fillStyle(0x17221b, 0.28);
        shadows.fillPoints(
          outer.map(p => new Phaser.Geom.Point(p.x + 4, p.y + 5)), true, true
        );
        roofs.fillStyle(shade, 1);
        roofs.fillPoints(points, true, true);

        // Landmarks e edifícios grandes recebem um tile de telhado repetido
        // apenas dentro do seu próprio footprint. A textura é local à
        // construção (nunca do tamanho do mapa inteiro), evitando OOM.
        const detailedRoof = Boolean(building.name) || (building.area_m2 || 0) > 2200;
        if (detailedRoof) {
          const maskShape = this.make.graphics({ x: 0, y: 0, add: false });
          maskShape.fillStyle(0xffffff, 1);
          maskShape.fillPoints(points, true, true);
          const roofFrame = commercial || industrial || institutional ? 23 : 22;
          const roofWidth = Math.max(32, bounds.maxX - bounds.minX);
          const roofHeight = Math.max(32, bounds.maxY - bounds.minY);
          this.add.tileSprite(
            bounds.minX, bounds.minY, roofWidth, roofHeight, "ara-tiles", roofFrame
          )
            .setOrigin(0)
            .setTileScale(3.2, 3.2)
            .setMask(maskShape.createGeometryMask())
            .setAlpha(0.24)
            .setDepth(29.5);
        }

        details.lineStyle(2, 0x342f2b, 0.92);
        details.strokePoints(points, true);
        details.lineStyle(1, 0xe0c49a, 0.58);
        details.strokePoints(
          outer.map(p => new Phaser.Geom.Point(p.x - 1, p.y - 1)), true, true
        );

        // Listras curtas simulam juntas e telhas dentro dos volumes menores.
        if (!detailedRoof && (building.area_m2 || 0) <= 12000) {
          const spacing = (building.area_m2 || 0) > 1800
            ? 48
            : Math.max(10, Math.min(19, Math.floor(
                (bounds.maxY - bounds.minY) / 3
              )));
          for (let y = bounds.minY + spacing; y < bounds.maxY - 3; y += spacing) {
            const intersections = [];
            for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
              const a = outer[j], b = outer[i];
              if ((a.y > y) !== (b.y > y)) {
                intersections.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
              }
            }
            intersections.sort((a, b) => a - b);
            details.lineStyle(1, commercial ? 0xd4dfd2 : 0x40332e, 0.34);
            for (let i = 0; i + 1 < intersections.length; i += 2) {
              details.lineBetween(intersections[i] + 2, y, intersections[i + 1] - 2, y);
            }
          }
        }

        // Amostra de telha do atlas em escala nativa, posicionada como detalhe.
        const roofFrame = commercial || industrial || institutional || variant === 1 ? 23 : 22;
        if (!detailedRoof && (building.area_m2 || 0) > 450) {
          const roofStampScale = Math.min(1.45, Math.max(0.7,
            Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 110
          ));
          this.add.image(center.x, center.y, "ara-tiles", roofFrame)
            .setScale(roofStampScale)
            .setAlpha(0.72)
            .setDepth(30.5);
        }

        let prefabFrame;
        if (industrial) {
          prefabFrame = 5;
        } else if (commercial) {
          prefabFrame = (building.area_m2 || 0) > 1800
            ? 3 : [3, 6, 7, 3][variant % 4];
        } else if (institutional || (building.area_m2 || 0) > 1800) {
          prefabFrame = 4;
        } else {
          const residenceType = String(style.residence_type || "").toLowerCase();
          const residenceFrames = {
            casa_terrea: [0, 1, 0, 7],
            casa_antiga: [1, 7, 1, 0],
            sobrado: [2, 2, 0, 2],
            casa_estendida: [7, 0, 7, 1]
          };
          const frames = residenceFrames[residenceType];
          prefabFrame = frames ? frames[variant % frames.length] : [0, 1, 2, 0][variant % 4];
        }

        const minDimension = Math.min(
          bounds.maxX - bounds.minX,
          bounds.maxY - bounds.minY
        );
        const prefabScale = Math.min(
          /shopping/i.test(building.name || "")
            ? 4.0
            : (building.area_m2 || 0) > 3000 ? 2.8 : 2.35,
          Math.max(0.58, minDimension / 64)
        );
        this.add.image(center.x, center.y, "ara-buildings", prefabFrame)
          .setScale(prefabScale)
          .setOrigin(0.5, 0.62)
          .setDepth(31 + center.y / 100000);

        if (building.name && (building.area_m2 || 0) > 700) {
          this.add.text(center.x, center.y - 38, building.name.toUpperCase(), {
            fontFamily: "Trebuchet MS, sans-serif",
            fontSize: (building.area_m2 || 0) > 3000 ? "16px" : "9px",
            fontStyle: "bold",
            color: "#fff1c7",
            stroke: "#28352c",
            strokeThickness: 4,
            backgroundColor: "#28352ccc",
            padding: { x: 4, y: 2 },
            align: "center"
          }).setOrigin(0.5).setDepth(35 + center.y / 100000)
            .setPosition(center.x, center.y - ((building.area_m2 || 0) > 3000 ? 72 : 38));
        }

        this.buildingCollision.push({
          rings: poly,
          bounds: {
            minX: bounds.minX - PLAYER_RADIUS,
            minY: bounds.minY - PLAYER_RADIUS,
            maxX: bounds.maxX + PLAYER_RADIUS,
            maxY: bounds.maxY + PLAYER_RADIUS
          },
          name: building.name || "",
          buildingType: type,
          center
        });
      }
    }
  }

  drawResidentialProperties() {
    const yards = this.add.graphics().setDepth(15);
    const garagePads = this.add.graphics().setDepth(18);
    const garageRoofs = this.add.graphics().setDepth(20);
    const wallShadow = this.add.graphics().setDepth(24);
    const wallFace = this.add.graphics().setDepth(25);
    const wallTexture = this.add.graphics().setDepth(25.5);
    const gateGraphics = this.add.graphics().setDepth(26);
    const cellSize = 256;
    this.wallCollision = new Map();
    this.residentialPropertyCount = 0;
    this.residentialMasks = [];

    const wallStyles = {
      plaster: { face: 0xc5baa1, shadow: 0x30372e, joint: 0xe4d8bd },
      brick: { face: 0x9b7057, shadow: 0x382f29, joint: 0x65483a },
      concrete: { face: 0x929a95, shadow: 0x303a35, joint: 0xb8c0b8 }
    };

    const addWallCollision = (a, b) => {
      const margin = PLAYER_RADIUS + 5;
      const minCellX = Math.floor((Math.min(a.x, b.x) - margin) / cellSize);
      const maxCellX = Math.floor((Math.max(a.x, b.x) + margin) / cellSize);
      const minCellY = Math.floor((Math.min(a.y, b.y) - margin) / cellSize);
      const maxCellY = Math.floor((Math.max(a.y, b.y) + margin) / cellSize);
      const wall = { a, b, radius: PLAYER_RADIUS + 2 };
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        for (let cx = minCellX; cx <= maxCellX; cx++) {
          const key = String(cx) + ":" + String(cy);
          if (!this.wallCollision.has(key)) this.wallCollision.set(key, []);
          this.wallCollision.get(key).push(wall);
        }
      }
    };

    const drawWallTexture = (a, b, type) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 8) return;
      const nx = -dy / length, ny = dx / length;
      const spacing = type === "brick" ? 11 : type === "concrete" ? 32 : 48;
      const halfThickness = type === "brick" ? 2.2 : 1.7;
      const jointColor = wallStyles[type].joint;
      wallTexture.lineStyle(type === "brick" ? 1.3 : 1, jointColor, 0.82);
      for (let offset = spacing; offset < length - 2; offset += spacing) {
        const px = a.x + dx * offset / length;
        const py = a.y + dy * offset / length;
        wallTexture.lineBetween(
          px - nx * halfThickness, py - ny * halfThickness,
          px + nx * halfThickness, py + ny * halfThickness
        );
      }
      if (type === "brick") {
        wallTexture.lineStyle(1, 0x5f493c, 0.7);
        const offset = Math.min(5, length * 0.25);
        wallTexture.lineBetween(
          a.x + dx * offset / length, a.y + dy * offset / length,
          b.x - dx * offset / length, b.y - dy * offset / length
        );
      }
    };

    for (const lot of this.mapData.lots) {
      const residence = lot.residential;
      if (!residence) continue;
      this.residentialPropertyCount++;

      const yardSurface = residence.yard?.surface || "grass";
      const yardTexture = yardSurface === "garden"
        ? "res-yard-garden" : yardSurface === "dirt" ? "res-yard-dirt" : "res-yard-grass";
      const yardPolygons = getFeaturePolygons(
        { polygons: residence.yard?.polygons || [] }, PPM
      );
      for (const polygon of yardPolygons) {
        if (!polygon.length || polygon[0].length < 3) continue;
        const points = polygon[0].map(point => new Phaser.Geom.Point(point.x, point.y));
        // Yards sit below houses and garages, so building footprints naturally hide holes.
        yards.fillStyle(
          yardSurface === "garden" ? 0x547b47 : yardSurface === "dirt" ? 0x806a4b : 0x527643,
          0.96
        );
        yards.fillPoints(points, true, true);
        this.drawResidentialSurface(yardTexture, points, 15.2);
      }

      const garagePolygons = getFeaturePolygons(
        { polygons: residence.garage || [] }, PPM
      );
      for (const polygon of garagePolygons) {
        if (!polygon.length || polygon[0].length < 3) continue;
        const points = polygon[0].map(point => new Phaser.Geom.Point(point.x, point.y));
        const bounds = polygonBounds(polygon[0]);
        const texture = residence.garage_type === "covered"
          ? "res-driveway-concrete"
          : (hash(lot.id) % 2 ? "res-driveway-pavers" : "res-driveway-concrete");
        garagePads.fillStyle(0x85877d, 0.98);
        garagePads.fillPoints(points, true, true);
        this.drawResidentialSurface(texture, points, 18.2);

        if (residence.garage_type === "covered") {
          garageRoofs.fillStyle(0x79513f, 0.96);
          garageRoofs.fillPoints(points, true, true);
          for (let y = bounds.minY + 9; y < bounds.maxY - 3; y += 8) {
            garageRoofs.lineStyle(2, 0x573e35, 0.9);
            garageRoofs.lineBetween(bounds.minX + 3, y, bounds.maxX - 3, y);
            garageRoofs.lineStyle(1, 0xb07d59, 0.8);
            garageRoofs.lineBetween(bounds.minX + 3, y + 2, bounds.maxX - 3, y + 2);
          }
        } else {
          garagePads.lineStyle(1, 0xb6b39e, 0.72);
          for (let y = bounds.minY + 9; y < bounds.maxY - 3; y += 9) {
            garagePads.lineBetween(bounds.minX + 2, y, bounds.maxX - 2, y);
          }
        }
      }

      const wallType = wallStyles[residence.wall_type] ? residence.wall_type : "plaster";
      const style = wallStyles[wallType];
      for (const segment of residence.walls || []) {
        if (!Array.isArray(segment) || segment.length !== 2) continue;
        const a = toWorld(segment[0], PPM);
        const b = toWorld(segment[1], PPM);
        wallShadow.lineStyle(8, style.shadow, 0.9);
        wallShadow.lineBetween(a.x + 1, a.y + 2, b.x + 1, b.y + 2);
        wallFace.lineStyle(wallType === "brick" ? 4.5 : 4, style.face, 1);
        wallFace.lineBetween(a.x, a.y, b.x, b.y);
        wallTexture.lineStyle(1, 0xe8dfc7, 0.42);
        wallTexture.lineBetween(a.x, a.y - 1, b.x, b.y - 1);
        drawWallTexture(a, b, wallType);
        addWallCollision(a, b);
      }

      for (const gate of residence.gates || []) {
        const line = gate.line || [];
        if (line.length !== 2) continue;
        const a = toWorld(line[0], PPM);
        const b = toWorld(line[1], PPM);
        const dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length, ny = dx / length;
        gateGraphics.lineStyle(4, 0x303a36, 1);
        gateGraphics.lineBetween(a.x, a.y, b.x, b.y);
        gateGraphics.lineStyle(2, 0xaeb7a7, 1);
        gateGraphics.lineBetween(a.x + nx * 2, a.y + ny * 2, b.x + nx * 2, b.y + ny * 2);
        const bars = Math.max(2, Math.floor(length / (gate.type === "vehicle" ? 9 : 7)));
        for (let index = 0; index <= bars; index++) {
          const t = index / bars;
          const px = a.x + dx * t, py = a.y + dy * t;
          gateGraphics.lineStyle(1.5, 0xc6c9b7, 0.92);
          gateGraphics.lineBetween(
            px - nx * 2, py - ny * 2, px + nx * 2, py + ny * 2
          );
        }
        gateGraphics.fillStyle(0xd0c19b, 1);
        gateGraphics.fillCircle(a.x, a.y, 2.5);
        gateGraphics.fillCircle(b.x, b.y, 2.5);
      }
    }
  }

  drawTrees() {
    this.treeCollision = [];
    const shadows = this.add.graphics().setDepth(44);
    for (const tree of (this.mapData.trees || [])) {
      const p = toWorld(tree.point, PPM);
      const kind = String(tree.kind || "").toLowerCase();
      const shrub = kind.includes("shrub") || kind.includes("bush");
      shadows.fillStyle(0x1d2d21, 0.38);
      shadows.fillEllipse(p.x + 3, p.y + 7, shrub ? 34 : 46, shrub ? 18 : 25);
      this.add.image(p.x, p.y, shrub ? "ara-shrub" : "ara-tree")
        .setOrigin(0.5, 0.72)
        .setDepth(45 + p.y / 100000);
      this.treeCollision.push({
        x: p.x, y: p.y + 3, radius: shrub ? 8 : 11
      });
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
    const cellSize = 256;
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor((y + 5) / cellSize);
    const wallPoint = { x, y: y + 5 };
    for (let cy = cellY - 1; cy <= cellY + 1; cy++) {
      for (let cx = cellX - 1; cx <= cellX + 1; cx++) {
        const nearbyWalls = this.wallCollision.get(`${cx}:${cy}`) || [];
        if (nearbyWalls.some(wall => distanceToSegment(wallPoint, wall.a, wall.b) < wall.radius)) {
          return true;
        }
      }
    }
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
    this.toast.setText(message).setOrigin(0.5).setVisible(true);
    this.setHudPosition(this.toast, width / 2, height - 112);
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
    this.setHudPosition(this.minimapPlayer, p.x, p.y);
  }

  // Converte coordenadas desejadas na tela para coordenadas do mundo HUD.
  // Isso neutraliza o zoom da câmera sem criar uma segunda câmera.
  screenToHudWorld(x, y) {
    const camera = this.cameras.main;
    const zoom = camera.zoom || 1;
    const centerX = camera.width / 2;
    const centerY = camera.height / 2;
    return {
      x: centerX + (x - centerX) / zoom,
      y: centerY + (y - centerY) / zoom
    };
  }

  setHudPosition(object, x, y) {
    if (!object) return;
    const point = this.screenToHudWorld(x, y);
    const zoom = this.cameras.main.zoom || 1;
    object.setPosition(point.x, point.y);
    object.setScale(1 / zoom);
  }

  layoutHud() {
    if (!this.minimapBg) return;
    const { width, height } = this.scale;
    if (this.mapData && this.minimapGraphics) this.drawMinimap();

    this.setHudPosition(this.titleText, 26, 22);
    this.setHudPosition(this.statusText, 28, 50);

    const x = width - 190;
    this.setHudPosition(this.minimapBg, x, 16);
    this.setHudPosition(this.minimapPlayer, x + 87, 16 + 65);
    if (this.minimapTitle) this.setHudPosition(this.minimapTitle, x + 87, 16 + 123);

    // O Graphics do minimapa desenha em coordenadas locais da tela.
    const zoom = this.cameras.main.zoom || 1;
    const centerX = width / 2;
    const centerY = height / 2;
    this.minimapGraphics
      .setPosition(centerX * (1 - 1 / zoom), centerY * (1 - 1 / zoom))
      .setScale(1 / zoom);

    if (this.toast?.visible) this.setHudPosition(this.toast, width / 2, height - 112);
  }
}
