import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const url = process.argv[2] || process.env.WORLD_EDITOR_E2E_URL ||
  "http://127.0.0.1:5173/?v4preview=1&buildings=1";
const candidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const exe = candidates.find(p => fs.existsSync(p));
if (!exe) throw new Error("Chrome/Edge não encontrado.");
const profile = path.join(os.tmpdir(), "ara_editor_ui_profile");
fs.rmSync(profile, { recursive: true, force: true });
const port = 9334;
const chrome = spawn(exe, [
  "--headless=new", "--remote-debugging-port=" + port, "--window-size=1280,720",
  "--user-data-dir=" + profile, "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist", "--no-first-run", "--no-default-browser-check", "about:blank"
], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
let id = 0;
const pending = new Map();
const errors = [];
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + port + "/json")).json();
      page = list.find(t => t.type === "page");
    } catch {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("Chrome DevTools não iniciou.");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
    }
  };
  const send = (method, params = {}) => new Promise(resolve => {
    const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Page.navigate", { url });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    ready = await evaluate("Boolean(window.__araScene?.devEditor && document.querySelector('.wed'))");
    if (ready) break;
  }
  if (!ready) throw new Error("World Editor não carregou.");
  const initial = await evaluate("({editorOpen:window.__araScene.devEditor.open,panelOpen:document.querySelector('.wed').classList.contains('open'),inspectorReady:Boolean(window.__araScene.devInspector)})");
  if (initial.editorOpen || initial.panelOpen) throw new Error("Editor deveria iniciar fechado.");

  const key = async type => send("Input.dispatchKeyEvent", {
    type, code: "F8", key: "F8", windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119
  });
  await key("keyDown"); await sleep(80); await key("keyUp"); await sleep(180);
  const opened = await evaluate("({editorOpen:window.__araScene.devEditor.open,panelOpen:document.querySelector('.wed').classList.contains('open'),hasEdit:document.querySelector('.wed').innerText.includes('Edição'),hasBuild:document.querySelector('.wed').innerText.includes('Construção'),buildReserved:document.querySelector('.wed').innerText.includes('em breve')})");
  if (!opened.editorOpen || !opened.panelOpen || !opened.hasEdit || !opened.hasBuild || !opened.buildReserved) {
    throw new Error("Painel F8 abriu com conteúdo inesperado: " + JSON.stringify(opened));
  }
  const liveEdit = await evaluate("(() => { " +
    "const s=window.__araScene,e=s.devEditor,m=s.chunkManager; " +
    "if (!m.showBuildings) return {error:'teste precisa de buildings=1'}; " +
    "let selected=null; " +
    "const center=ring=>{let area2=0,cx=0,cy=0; for(let i=0;i<ring.length-1;i++){const a=ring[i],b=ring[i+1],cross=a.x*b.y-b.x*a.y; area2+=cross;cx+=(a.x+b.x)*cross;cy+=(a.y+b.y)*cross;} return Math.abs(area2)>1e-6?{x:cx/(3*area2),y:cy/(3*area2)}:{x:ring.reduce((v,p)=>v+p.x,0)/ring.length,y:ring.reduce((v,p)=>v+p.y,0)/ring.length};}; " +
    "for(const c of m.loaded.values()){if(c.state!=='loaded')continue;for(const b of c.record?.buildings||[]){for(const poly of b.polygons||[]){const ring=poly[0];if(!ring||ring.length<4)continue;const p=center(ring);const hit=e.selectAt(p);if(hit?.kind==='building'){selected=hit;break;}}if(selected)break;}if(selected)break;} " +
    "if(!selected)return {error:'nenhuma construção selecionável nos chunks carregados',loaded:m.loaded.size}; " +
    "const id=selected.id,ci=Number(id.slice(id.lastIndexOf(':')+1)),collisionKey=String(selected.feature.id)+':'+ci; " +
    "const collisionBefore=s.buildingCollision.some(c=>c.key===collisionKey); " +
    "e.removeSelected(); " +
    "const removed=e.store.effective(id).removed===true&&!m.isElementRendered(id); " +
    "const collisionRemoved=!s.buildingCollision.some(c=>c.key===collisionKey); " +
    "const saved=JSON.parse(localStorage.getItem('aracatexas.worldmods.v1')||'{}'); " +
    "const persisted=saved.mods?.[id]?.removed===true; " +
    "e.undo(); const undone=m.isElementRendered(id)&&s.buildingCollision.some(c=>c.key===collisionKey); " +
    "e.redo(); const redone=e.store.effective(id).removed===true&&!m.isElementRendered(id); " +
    "e.restoreSelected(); const restored=!e.store.entry(id)&&m.isElementRendered(id)&&s.buildingCollision.some(c=>c.key===collisionKey); " +
    "return {ok:collisionBefore&&removed&&collisionRemoved&&persisted&&undone&&redone&&restored,id,collisionBefore,removed,collisionRemoved,persisted,undone,redone,restored}; " +
  "})()");
  if (!liveEdit.ok) throw new Error("Edição real da construção falhou: " + JSON.stringify(liveEdit));
  await send("Input.dispatchKeyEvent", { type: "keyDown", code: "F7", key: "F7", windowsVirtualKeyCode: 118, nativeVirtualKeyCode: 118 });
  await sleep(80);
  await send("Input.dispatchKeyEvent", { type: "keyUp", code: "F7", key: "F7", windowsVirtualKeyCode: 118, nativeVirtualKeyCode: 118 });
  await sleep(180);
  const bothOpen = await evaluate("({editorOpen:window.__araScene.devEditor.open,inspectorOpen:window.__araScene.devInspector.open,editorPanelOpen:document.querySelector('.wed').classList.contains('open')})");
  if (!bothOpen.editorOpen || !bothOpen.inspectorOpen || !bothOpen.editorPanelOpen) {
    throw new Error("F7 e F8 não permaneceram independentes: " + JSON.stringify(bothOpen));
  }
  await key("keyDown"); await sleep(80); await key("keyUp"); await sleep(150);
  const closed = await evaluate("({editorOpen:window.__araScene.devEditor.open,inspectorOpen:window.__araScene.devInspector.open,panelOpen:document.querySelector('.wed').classList.contains('open')})");
  if (closed.editorOpen || closed.panelOpen || !closed.inspectorOpen) {
    throw new Error("Fechar o F8 afetou o estado do F7: " + JSON.stringify(closed));
  }
  if (errors.length) throw new Error("Erros no navegador: " + errors.join(" | "));
  console.log("UI WORLD EDITOR PASSOU", JSON.stringify({ initial, opened, liveEdit, bothOpen, closed, errors }));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(200);
  fs.rmSync(profile, { recursive: true, force: true });
}
