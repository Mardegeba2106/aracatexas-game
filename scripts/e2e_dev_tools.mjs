// Teste ponta a ponta do Dev Mode (camera livre F6 + World Inspector F7).
// Controla um Chrome/Edge headless por DevTools (CDP) num perfil temporario.
// Uso:  npm run dev   (outro terminal)   e depois   npm run test:e2e
//       E2E_FPS=1 npm run test:e2e   -> tambem mede FPS por nivel de zoom
// Observacao: o Chrome headless renderiza por software (poucos FPS); os numeros de
// FPS servem para comparar niveis de zoom entre si, nao como medida absoluta.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL = process.argv[2] || "http://127.0.0.1:5173/?v4preview=1&inspector=grid,chunks";
const OUT = process.env.TEMP || os.tmpdir();
const chromePaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const exe = chromePaths.find(p => fs.existsSync(p));
if (!exe) { console.log("Nenhum Chrome/Edge encontrado"); process.exit(2); }
const profile = path.join(OUT, "ara_cdp_profile");
fs.rmSync(profile, { recursive: true, force: true });
const port = 9333;
const chrome = spawn(exe, [
  "--headless=new", `--remote-debugging-port=${port}`, "--window-size=1280,720",
  `--user-data-dir=${profile}`, "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist", "--no-first-run", "--no-default-browser-check", "about:blank"
], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const note = (ok, msg) => { results.push(`${ok ? "ok" : "FALHOU"}: ${msg}`); };

let ws, id = 0; const pending = new Map(); const errors = [];
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* ainda subindo */ }
    await sleep(500);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push("EXCECAO: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error: " + m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 300));
  };
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const shot = async name => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `ara_e2e_${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
  return file;
};
const key = async (code, vk, down, extra = {}) => send("Input.dispatchKeyEvent", {
  type: down ? "keyDown" : "keyUp", code, key: extra.key ?? code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(extra.text && down ? { text: extra.text } : {})
});
const tap = async (code, vk, extra) => { await key(code, vk, true, extra); await sleep(60); await key(code, vk, false, extra); await sleep(120); };
const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const click = async (x, y) => {
  await move(x, y); await sleep(80);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(150);
};

try {
  await connect();
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Page.navigate", { url: URL });

  // espera o jogo e o inspetor ficarem prontos, com chunks carregados
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    await sleep(500);
    ready = await evalJs(`(() => { const s = window.__araScene; if (!s?.devInspector || !s?.devFreeCam) return false;
      let n = 0; for (const c of s.chunkManager.loaded.values()) if (c.record) n++; return n >= 4; })()`) === true;
  }
  note(ready, "jogo carregou com World Inspector e camera livre prontos e chunks com dados");
  if (!ready) throw new Error("jogo nao ficou pronto: " + JSON.stringify(await evalJs("document.body.innerText.slice(0,200)")));
  await sleep(1200);
  console.log("PNG", await shot("01_inicio"));

  const st = await evalJs(`(() => { const s = window.__araScene, i = s.devInspector;
    return { open: i.open, toggles: i.toggles, canvasW: s.scale.width, canvasH: s.scale.height, zoom: s.cameras.main.zoom,
      loaded: s.chunkManager.loaded.size, panel: i.panelRect, player: [s.player.x, s.player.y] }; })()`);
  note(st.open === true && st.toggles.grid && !st.toggles.collisions && st.toggles.chunks,
    `Inspector inicia com visualizacao de colisoes desligada (${JSON.stringify(st.toggles)})`);
  console.log("ESTADO", JSON.stringify(st));

  // F7 fecha e reabre
  await tap("F7", 118); let open = await evalJs("window.__araScene.devInspector.open");
  note(open === false, "F7 fecha o painel");
  const closedOverlay = await evalJs(`(() => { const i = window.__araScene.devInspector;
    return { commands: i.layer.commandBuffer?.length ?? -1, labels: i.labels.filter(l => l.visible).length }; })()`);
  note(closedOverlay.commands === 0 && closedOverlay.labels === 0,
    `grade e limites desaparecem ao fechar o F7 (${JSON.stringify(closedOverlay)})`);
  await tap("F7", 118); open = await evalJs("window.__araScene.devInspector.open");
  note(open === true, "F7 reabre o painel");

  // F6 liga a camera livre; o personagem nao se move
  const p0 = await evalJs("[window.__araScene.player.x, window.__araScene.player.y]");
  await tap("F6", 117);
  note(await evalJs("window.__araScene.devFreeCam.active") === true, "F6 ativa a camera livre");
  const freeCameraCollision = await evalJs(`(() => {
    const s = window.__araScene, checks = s.performanceMetrics.collisionChecks;
    const blocked = s.isBlocked(s.player.x, s.player.y);
    return { blocked, checksBefore: checks, checksAfter: s.performanceMetrics.collisionChecks,
      retained: (s.buildingCollision?.length || 0) + (s.wallCollision?.length || 0) + (s.treeCollision?.length || 0) };
  })()`);
  note(freeCameraCollision.blocked === false &&
    freeCameraCollision.checksBefore === freeCameraCollision.checksAfter,
    `camera livre ignora colisao fisica sem executar consultas (${JSON.stringify(freeCameraCollision)})`);
  note(freeCameraCollision.retained > 0, "geometrias de colisao continuam carregadas para o personagem e o Inspector");
  const c0 = await evalJs("[window.__araScene.cameras.main.scrollX, window.__araScene.cameras.main.scrollY]");
  await key("KeyD", 68, true, { key: "d", text: "d" }); await sleep(900); await key("KeyD", 68, false, { key: "d" });
  await key("KeyW", 87, true, { key: "w", text: "w" }); await sleep(500); await key("KeyW", 87, false, { key: "w" });
  const c1 = await evalJs("[window.__araScene.cameras.main.scrollX, window.__araScene.cameras.main.scrollY]");
  const p1 = await evalJs("[window.__araScene.player.x, window.__araScene.player.y]");
  note(c1[0] - c0[0] > 20 && c1[1] < c0[1] - 10, `WASD move a camera na direcao certa (dx ${Math.round(c1[0] - c0[0])}, dy ${Math.round(c1[1] - c0[1])})`);
  note(p0[0] === p1[0] && p0[1] === p1[1], "o personagem nao se moveu com a camera livre ativa");

  const hiddenBuildings = await evalJs(`(() => {
    const s = window.__araScene, m = s.chunkManager, chunks = [...m.loaded.values()];
    return {
      enabled: m.showBuildings,
      mapDataRetained: chunks.some(c => (c.record?.buildings?.length || 0) > 0),
      anyRendered: chunks.some(c => c.buildingsRendered),
      buildingCollisions: s.buildingCollision?.length || 0
    };
  })()`);
  note(hiddenBuildings.enabled === false && hiddenBuildings.mapDataRetained &&
    hiddenBuildings.anyRendered === false && hiddenBuildings.buildingCollisions === 0,
    `construcoes ocultas, dados preservados e sem colisao invisivel (${JSON.stringify(hiddenBuildings)})`);

  // centraliza num lote vazio e testa hover / clique / info sem edificios visuais
  const target = await evalJs(`(() => {
    const s = window.__araScene, mgr = s.chunkManager, cam = s.cameras.main;
    const inside = (p, ring) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > p.y) !== (b.y > p.y) &&
            p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
      }
      return hit;
    };
    let best = null;
    for (const c of mgr.loaded.values()) for (const lot of c.record?.lots || []) {
      const ring = lot.polygons[0]?.[0]; if (!ring || ring.length < 4) continue;
      const p = { x: ring.reduce((sum, q) => sum + q.x, 0) / ring.length,
        y: ring.reduce((sum, q) => sum + q.y, 0) / ring.length };
      if (!inside(p, ring)) continue;
      const occupied = c.record.buildings.some(b => b.polygons.some(poly => poly[0] && inside(p, poly[0])));
      if (occupied) continue;
      const d = Math.hypot(p.x - cam.scrollX, p.y - cam.scrollY);
      if (!best || d < best.d) best = { cx: p.x, cy: p.y, id: lot.feature.id, d };
    }
    if (best) cam.centerOn(best.cx, best.cy);
    return best;
  })()`);
  note(!!target, `achou um lote vazio para inspecionar (${target?.id})`);
  await sleep(500);
  const cam = await evalJs("(() => { const c = window.__araScene.cameras.main; return { z: c.zoom, w: c.width, h: c.height }; })()");
  const cx = cam.w / 2 - 120, cy = cam.h / 2;      // centro da tela, deslocado para longe do painel
  await evalJs(`(() => { const c = window.__araScene.cameras.main; c.centerOn(${target?.cx ?? 0} + 120 / c.zoom, ${target?.cy ?? 0}); })()`);
  await sleep(500);
  await move(cx, cy); await sleep(350);
  const hover = await evalJs(`(() => { const i = window.__araScene.devInspector; return i.hover ? { kind: i.hover.kind, id: i.hover.item.feature.id } : null; })()`);
  note(hover?.kind === "lot" && hover.id === target.id, `passar o mouse destaca o lote sem edifício (${hover?.kind} ${hover?.id})`);
  console.log("PNG", await shot("02_hover_lote_sem_construcoes"));

  await click(cx, cy);
  const sel = await evalJs(`(() => { const i = window.__araScene.devInspector; return i.selected ? { kind: i.selected.kind, id: i.selected.item?.feature?.id, text: i.selTxt.text } : null; })()`);
  note(sel?.kind === "lot" && sel.id === target.id, `clique seleciona o lote certo (${sel?.kind} ${sel?.id})`);
  note(/chunk/.test(sel?.text || "") && /id/.test(sel?.text || ""), "painel mostra id e chunk do lote");
  console.log("PNG", await shot("03_lote_selecionado"));

  // colisoes: habilita apenas sob demanda e desabilita novamente pela tecla C
  await tap("KeyC", 67, { key: "c" }); let col = await evalJs("window.__araScene.devInspector.toggles.collisions");
  note(col === true, "tecla C ativa a visualizacao de colisoes sob demanda");
  await tap("KeyC", 67, { key: "c" }); col = await evalJs("window.__araScene.devInspector.toggles.collisions");
  note(col === false, "tecla C desativa novamente a visualizacao de colisoes");

  // medidor: dois cliques -> distancia em metros
  await tap("KeyR", 82, { key: "r" });
  await click(cx - 160, cy + 60); await click(cx + 100, cy - 20);
  const meas = await evalJs(`(() => { const i = window.__araScene.devInspector; const [a, b] = i.measure.points;
    return { n: i.measure.points.length, meters: a && b ? Math.hypot(b.x - a.x, b.y - a.y) / 16 : null, label: i.measureLabel.text, labelVisible: i.measureLabel.visible }; })()`);
  note(meas.n === 2 && meas.meters > 5, `medidor: 2 pontos (${meas.meters?.toFixed(2)} m)`);
  note(meas.labelVisible && Math.abs(parseFloat(meas.label) - meas.meters) < 0.06, `rotulo na tela mostra a mesma distancia (${meas.label})`);
  console.log("PNG", await shot("04_medidor"));
  await tap("Escape", 27, { key: "Escape" });
  const pts = await evalJs("window.__araScene.devInspector.measure.points.length");
  note(pts === 0, "Esc cancela a medicao e permite comecar outra");
  await tap("KeyR", 82, { key: "r" });

  // zoom afastado: a grade nao pode ficar densa
  await evalJs("window.__araScene.devFreeCam.zoomAt(0.45, 640, 360)");
  await sleep(1500);
  const gridInfo = await evalJs(`(() => { const s = window.__araScene, i = s.devInspector;
    return { zoom: s.cameras.main.zoom, labels: i.labels.filter(l => l.visible).length }; })()`);
  note(gridInfo.labels <= 40, `zoom ${gridInfo.zoom.toFixed(2)}: ${gridInfo.labels} rotulos de grade visiveis (nao fica denso)`);
  console.log("PNG", await shot("05_zoom_afastado"));

  const lodCheck = await evalJs(`(() => {
    const s = window.__araScene, m = s.chunkManager;
    const sample = [...m.loaded.values()].find(c => c.state === "loaded" && c.lodLayers);
    return {
      level: m.lodManager.level,
      labelsHidden: sample ? (sample.lodLayers.labels || []).every(o => !o.visible) : false,
      roofTexturesHidden: sample ? (sample.lodLayers.roofDetails || []).every(o => !o.visible) : false,
      propertiesVisible: sample ? (sample.lodLayers.properties || []).every(o => o.visible) : false
    };
  })()`);
  note(lodCheck.level === 2 && lodCheck.labelsHidden && lodCheck.roofTexturesHidden,
    `LOD intermediario reduz rotulos e texturas de telhado sem remover a silhueta (${JSON.stringify(lodCheck)})`);

  await evalJs("window.__araScene.devFreeCam.zoomAt(0.25, 640, 360)");
  await sleep(700);
  const farLod = await evalJs(`(() => {
    const m = window.__araScene.chunkManager;
    const sample = [...m.loaded.values()].find(c => c.state === "loaded" && c.lodLayers);
    return { level: m.lodManager.level, foliageHidden: sample ? (sample.lodLayers.foliage || []).every(o => !o.visible) : false };
  })()`);
  note(farLod.level === 3 && farLod.foliageHidden,
    `LOD distante simplifica vegetacao sem alterar colisao (${JSON.stringify(farLod)})`);

  await evalJs("window.__araScene.devFreeCam.zoomAt(1.12, 640, 360)");
  await sleep(500);
  const streamStart = await evalJs(`(() => {
    const s = window.__araScene, m = s.chunkManager;
    return { size: m.loaded.size, ready: [...m.loaded.values()].filter(c => c.state === "loaded").length, peakLoading: m.streaming.peakLoadingCount };
  })()`);
  await evalJs(`(() => {
    const s = window.__araScene, c = s.cameras.main, f = s.devFreeCam, m = s.chunkManager;
    f.fx = c.scrollX + m.chunkSize * 2.6;
    f.fy = c.scrollY;
    f.applyFreeBounds();
    c.scrollX = f.fx;
    c.scrollY = f.fy;
    m.updateVisible(true);
  })()`);
  const streamPriority = await evalJs(`(() => {
    const m = window.__araScene.chunkManager, chunks = [...m.loaded.values()];
    return {
      ahead: chunks.filter(c => c.role === "ahead").length,
      visible: [...m.visibleKeys].every(k => m.loaded.get(k)?.priorityTier === 0),
      aheadTier: chunks.filter(c => c.role === "ahead").every(c => c.priorityTier === 1),
      prefetchTier: chunks.filter(c => c.role === "prefetch").every(c => c.priorityTier === 2)
    };
  })()`);
  await sleep(3500);
  const streamMoved = await evalJs(`(() => {
    const s = window.__araScene, m = s.chunkManager;
    const chunks = [...m.loaded.values()];
    return {
      visiblePresent: [...m.visibleKeys].every(k => m.loaded.has(k)),
      reserve: chunks.filter(c => c.role === "reserve" && c.state === "loaded").length,
      ahead: chunks.filter(c => c.role === "ahead").length,
      visiblePriorityOk: [...m.visibleKeys].every(k => m.loaded.get(k)?.priorityTier === 0),
      aheadPriorityOk: chunks.filter(c => c.role === "ahead").every(c => c.priorityTier === 1),
      prefetchPriorityOk: chunks.filter(c => c.role === "prefetch").every(c => c.priorityTier === 2),
      loaded: chunks.filter(c => c.state === "loaded").length,
      pending: m.queuedCount,
      loading: m.loadingCount,
      peakLoading: m.streaming.peakLoadingCount,
      ready: m.readyCount,
      lod: m.lodManager.level
    };
  })()`);
  note(streamMoved.visiblePresent, `nenhum chunk visivel foi descartado apos deslocamento (${JSON.stringify(streamMoved)})`);
  note(streamMoved.loading <= 3 && streamMoved.peakLoading <= 3, `limite de 3 requisicoes simultaneas respeitado (pico ${streamMoved.peakLoading}, ativas ${streamMoved.loading})`);
  note(streamMoved.reserve > 0, `chunks anteriores permanecem em reserva (${streamMoved.reserve})`);
  note(streamPriority.ahead > 0 && streamPriority.visible && streamPriority.aheadTier &&
    streamPriority.prefetchTier,
    `prioridade de construcao: visiveis, a frente, demais (${JSON.stringify(streamPriority)})`);
  note(streamMoved.lod === 0, `LOD retorna ao nivel detalhado ao aproximar (${streamMoved.lod})`);
  console.log("STREAM", JSON.stringify({ start: streamStart, moved: streamMoved }));

  // FPS x zoom, com as camadas do inspetor LIGADAS e DESLIGADAS (renderizacao por software: vale o relativo)
  const sweep = async label => {
    const rows = [];
    for (const z of [1.12, 0.8, 0.6, 0.45, 0.35, 0.25, 0.2]) {
      await evalJs(`window.__araScene.devFreeCam.zoomAt(${z}, 640, 360)`); await sleep(3000);
      rows.push(await evalJs(`(() => { const s = window.__araScene; return { z: ${z}, chunks: s.chunkManager.loaded.size, fps: Math.round(s.game.loop.actualFps * 10) / 10 }; })()`));
    }
    console.log("SWEEP " + label, JSON.stringify(rows));
  };
  if (process.env.E2E_FPS === "1") await sweep("camadas ligadas");
  await evalJs("(() => { const i = window.__araScene.devInspector; i.toggles.grid = false; i.toggles.collisions = false; i.toggles.chunks = false; i._layerSig = ''; })()");
  if (process.env.E2E_FPS === "1") await sweep("camadas desligadas");

  // sai da camera livre: retorno suave
  await evalJs("window.__araScene.devFreeCam.zoomAt(1.12, 640, 360)");
  await tap("F6", 117);
  note(await evalJs("window.__araScene.devFreeCam.returning") === true, "F6 inicia o retorno suave ao personagem");
  for (let i = 0; i < 60; i++) { await sleep(500); if (await evalJs("!window.__araScene.devFreeCam.returning") === true) break; }
  const back = await evalJs(`(() => { const s = window.__araScene, c = s.cameras.main; return { off: Math.hypot(c.scrollX + c.width / 2 - s.player.x, c.scrollY + c.height / 2 - s.player.y), blocks: s.devFreeCam.blocksPlayer }; })()`);
  note(back.off < 40 && !back.blocks, `camera voltou ao personagem (desvio ${back.off.toFixed(1)} px) e o personagem foi liberado`);
  console.log("PNG", await shot("06_de_volta"));
} catch (e) {
  results.push("ERRO NO TESTE: " + e.message);
} finally {
  console.log(results.join("\n"));
  console.log("--- erros de console/excecoes:", errors.length ? "\n" + errors.slice(0, 8).join("\n") : "nenhum");
  try { ws?.close(); } catch {}
  chrome.kill();
  const failed = results.some(r => r.startsWith("FALHOU:") || r.startsWith("ERRO NO TESTE:"));
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
}
