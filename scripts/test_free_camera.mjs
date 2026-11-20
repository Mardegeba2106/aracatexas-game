// Testa a lógica da câmera livre (Dev Mode) em Node, com mocks do Phaser.
// Uso: node scripts/test_free_camera.mjs
import { FreeCamera } from "../src/dev/FreeCamera.js";

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.log("FALHOU:", msg); } else console.log("ok:", msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function makeScene() {
  const calls = [];
  const writes = new Set();
  const camState = { scrollX: 100, scrollY: 200, zoom: 1.12, width: 1280, height: 720, useBounds: true, rotation: 0 };
  const cam = new Proxy(camState, { set(t, k, v) { writes.add(String(k)); t[k] = v; return true; } });
  Object.assign(camState, {
    stopFollow() { calls.push(["stopFollow"]); },
    removeBounds() { calls.push(["removeBounds"]); camState.useBounds = false; },
    setBounds(...a) { calls.push(["setBounds", ...a]); camState.useBounds = true; },
    startFollow(...a) { calls.push(["startFollow", ...a.slice(1)]); },
    setZoom(z) { cam.zoom = z; },
    zoomTo(z, ms, ease, force) { calls.push(["zoomTo", z, ms]); },
    pan(x, y, ms, ease, force, cb) { calls.push(["pan", x, y, ms]); camState._panCb = cb; }
  });
  const keyObjs = {};
  const keyboard = { addCapture() {}, addKey(code) { return keyObjs[code] ??= { isDown: false }; } };
  const scene = {
    cameras: { main: cam }, input: { keyboard, on() {}, off() {} },
    scale: { on() {}, off() {}, height: 720 }, events: { once() {} },
    player: { x: 5000, y: -3000, anims: { stop() { calls.push(["playerStop"]); } } }
  };
  const press = (code, down) => { (keyObjs[code] ??= { isDown: false }).isDown = down; };
  return { scene, cam, camState, calls, writes, press };
}
const BOUNDS = { x: -8000, y: -8000, width: 16000, height: 16000 };
// Simula o preRender do Phaser com roundPixels: faz floor no scroll e grava de volta a cada quadro.
const frames = (fc, n, ms = 16) => {
  const cam = fc.scene.cameras.main;
  for (let i = 0; i < n; i++) { fc.update(ms); cam.scrollX = Math.floor(cam.scrollX); cam.scrollY = Math.floor(cam.scrollY); }
};

// 1) F6 liga, para o follow, remove limites e trava o personagem
{
  const { scene, calls, press } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS });
  ok(!fc.blocksPlayer, "desligada por padrão: personagem livre");
  press(117, true); fc.update(16); press(117, false);
  ok(fc.active && fc.blocksPlayer, "F6 ativa a câmera livre e bloqueia o personagem");
  ok(calls.some(c => c[0] === "stopFollow") && calls.some(c => c[0] === "removeBounds"), "para de seguir e remove os limites do mapa");
  press(117, true); frames(fc, 10);
  ok(fc.active, "F6 segurado não alterna a cada quadro");
}

// 2) movimento: WASD, diagonal, Shift e independência do zoom
{
  const { scene, camState, press } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS });
  fc.enable();
  const x0 = camState.scrollX;
  press(68, true); frames(fc, 60); press(68, false);          // D por ~0,96 s
  const dX = camState.scrollX - x0;
  ok(dX > 0 && near(camState.scrollY, 200), `D move só no eixo X (${dX.toFixed(0)} px do mundo)`);
  ok(near(dX, (700 / 1.12) * 0.96, 2), "velocidade no mundo = velocidade / zoom");

  camState.scrollX = 0; camState.scrollY = 0;
  press(68, true); press(83, true); frames(fc, 30); press(68, false); press(83, false);
  const diag = Math.hypot(camState.scrollX, camState.scrollY);
  camState.scrollX = 0; camState.scrollY = 0;
  press(68, true); frames(fc, 30); press(68, false);
  // tolerância de 2 px: a simulação do roundPixels faz floor em cada eixo (até 1 px de erro por eixo)
  ok(near(diag, camState.scrollX, 2), `diagonal não é mais rápida que o eixo reto (${diag.toFixed(1)} x ${camState.scrollX.toFixed(1)} px)`);

  camState.scrollX = 0; press(16, true); press(68, true); frames(fc, 30); press(68, false); press(16, false);
  ok(near(camState.scrollX, (700 * 3.5 / 1.12) * 0.48, 2), "Shift multiplica a velocidade por 3,5");
}

// 2b) velocidade baixa com roundPixels: nada de travar nem de andar mais para um lado
{
  const { scene, camState, press } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS, baseSpeed: 100 }); fc.enable(); camState.zoom = 4;
  const x0 = camState.scrollX, y0 = camState.scrollY;
  press(68, true); frames(fc, 125); press(68, false);            // direita, 2 s
  const right = camState.scrollX - x0;
  press(65, true); frames(fc, 125); press(65, false);            // esquerda, 2 s
  const back = camState.scrollX - x0;
  ok(Math.abs(right - 50) <= 2, `direita em velocidade baixa anda o esperado (${right} de 50 px)`);
  ok(Math.abs(back) <= 2, `esquerda volta ao ponto de partida (sobra ${back} px)`);
  press(83, true); frames(fc, 125); press(83, false);
  ok(Math.abs((camState.scrollY - y0) - 50) <= 2, `para baixo também anda (${camState.scrollY - y0} de 50 px)`);
}

// 3) zoom: limites e ponto sob o cursor preservado
{
  const { scene, camState } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS }); fc.enable();
  const world = (sx, sy) => ({
    x: camState.scrollX + 640 - 640 / camState.zoom + sx / camState.zoom,
    y: camState.scrollY + 360 - 360 / camState.zoom + sy / camState.zoom
  });
  const before = world(900, 200);
  fc.zoomAt(2.5, 900, 200);
  const after = world(900, 200);
  ok(near(before.x, after.x, 1e-6) && near(before.y, after.y, 1e-6), "zoom mantém fixo o ponto sob o cursor");
  fc.zoomAt(0.001, 640, 360); ok(near(camState.zoom, 0.2), "zoom mínimo respeitado (0,2)");
  fc.zoomAt(999, 640, 360); ok(near(camState.zoom, 4), "zoom máximo respeitado (4)");
  fc.onWheel({ x: 640, y: 360 }, [], 0, -100); ok(near(camState.zoom, 4), "scroll acima do máximo continua em 4");
  fc.zoomAt(1, 640, 360); fc.onWheel({ x: 640, y: 360 }, [], 0, -100);
  ok(camState.zoom > 1, "scroll para cima aproxima");
}

// 4) tecla 0 restaura o zoom padrão e +/- aproximam/afastam
{
  const { scene, camState, press } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS }); fc.enable();
  press(187, true); frames(fc, 30); press(187, false);
  ok(camState.zoom > 1.12, "+ aproxima");
  press(189, true); frames(fc, 90); press(189, false);
  ok(camState.zoom < 1.12, "- afasta");
  press(48, true); fc.update(16); press(48, false);
  ok(near(camState.zoom, 1.12, 1e-6), "0 restaura o zoom padrão do jogo");
}

// 5) perspectiva intacta: só scroll e zoom são escritos na câmera
{
  const { scene, camState, writes, press } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS }); fc.enable();
  press(68, true); press(87, true); frames(fc, 20); fc.zoomAt(0.5, 300, 300); fc.onWheel({ x: 10, y: 10 }, [], 0, 100);
  const allowed = new Set(["scrollX", "scrollY", "zoom", "useBounds"]);
  const extra = [...writes].filter(k => !allowed.has(k));
  ok(extra.length === 0 && camState.rotation === 0, `só scroll/zoom são alterados (extras: ${extra.join(",") || "nenhum"})`);
}

// 6) sair: retorno suave ao personagem, restaura limites e follow
{
  const { scene, camState, calls } = makeScene();
  const fc = new FreeCamera(scene, { bounds: BOUNDS }); fc.enable(); fc.disable();
  ok(fc.returning && fc.blocksPlayer && !fc.active, "durante o retorno o personagem continua bloqueado");
  const pan = calls.find(c => c[0] === "pan"), zoom = calls.find(c => c[0] === "zoomTo");
  ok(pan && pan[1] === 5000 && pan[2] === -3000, "pan suave até a posição do personagem");
  ok(zoom && near(zoom[1], 1.12), "zoom volta ao valor que o jogo tinha");
  fc.toggle(); ok(fc.returning, "F6 durante o retorno é ignorado");
  camState._panCb(camState, 0.5); ok(fc.returning, "retorno ainda em andamento a 50%");
  camState._panCb(camState, 1);
  ok(!fc.returning && !fc.blocksPlayer, "ao terminar o personagem volta a responder");
  ok(calls.some(c => c[0] === "setBounds" && c[1] === -8000) && calls.some(c => c[0] === "startFollow"), "limites e acompanhamento restaurados");
}

// 7) atalhos por evento: um toque curto entre dois quadros ainda conta (FPS baixo)
{
  const { scene, camState } = makeScene();
  const handlers = {};
  const kb = scene.input.keyboard, plain = kb.addKey.bind(kb);
  kb.addKey = code => { const k = plain(code); k.on = (ev, fn) => { (handlers[code] ??= []).push([ev, fn]); }; return k; };
  const fc = new FreeCamera(scene, { bounds: BOUNDS });
  const fire = code => (handlers[code] || []).forEach(([ev, fn]) => ev === "down" && fn());
  ok(fc.eventDriven, "com teclas que emitem eventos, a camera usa o caminho por evento");
  fire(117); ok(fc.active, "evento F6 liga a camera sem precisar de isDown (toque entre quadros)");
  fire(190); fc.update(16); ok(near(fc.speed, 700 * 1.25), "evento '.' aumenta a velocidade");
  fire(188); fc.update(16); ok(near(fc.speed, 700), "evento ',' diminui a velocidade");
  fc.zoomAt(2, 640, 360); fire(48); fc.update(16); ok(near(camState.zoom, 1.12, 1e-6), "evento 0 restaura o zoom padrao");
  fire(117); ok(fc.returning && !fc.active, "evento F6 de novo inicia o retorno");
}

console.log(failed ? `\n${failed} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(failed ? 1 : 0);
