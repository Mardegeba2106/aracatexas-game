import Phaser from "phaser";
import "./style.css";
import WorldScene from "./scenes/WorldScene.js";

window.__araControls = {
  up: false, down: false, left: false, right: false, interact: false
};

function bindHold(button, key) {
  if (!button) return;
  const press = (event) => {
    event.preventDefault();
    window.__araControls[key] = true;
    button.setPointerCapture?.(event.pointerId);
  };
  const release = (event) => {
    event.preventDefault();
    window.__araControls[key] = false;
  };
  button.addEventListener("pointerdown", press, { passive: false });
  ["pointerup", "pointercancel", "lostpointercapture", "pointerleave"].forEach(type => {
    button.addEventListener(type, release, { passive: false });
  });
}
document.querySelectorAll("[data-dir]").forEach(button => {
  bindHold(button, button.dataset.dir);
});
bindHold(document.querySelector("#touch-interact"), "interact");
window.addEventListener("blur", () => {
  Object.keys(window.__araControls).forEach(key => window.__araControls[key] = false);
});

const config = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#263c30",
  pixelArt: true,
  roundPixels: true,
  antialias: false,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720
  },
  render: {
    pixelArt: true,
    antialias: false,
    roundPixels: true
  },
  scene: [WorldScene]
};

new Phaser.Game(config);
