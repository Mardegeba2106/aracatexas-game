import assert from "node:assert/strict";
import ChunkStreamingManager from "../src/scenes/ChunkStreamingManager.js";
import WorldLODManager, { resolveLodLevel } from "../src/scenes/WorldLODManager.js";

const scheduler = new ChunkStreamingManager({
  maxConcurrentLoads: 3,
  maxBuildsPerFrame: 1,
  reserveLimit: 16
});
const chunks = Array.from({ length: 5 }, (_, i) => ({ key: `chunk-${i}` }));
chunks.forEach((chunk, index) => scheduler.enqueue(chunk, index === 4 ? -10 : index));

assert.equal(scheduler.queuedCount, 5, "all requests enter the pending queue");
assert.equal(scheduler.loadingCount, 0, "queue does not start requests on enqueue");
assert.equal(scheduler.startNextLoad().key, "chunk-4", "highest-priority chunk starts first");
assert.equal(scheduler.startNextLoad().key, "chunk-0");
assert.equal(scheduler.startNextLoad().key, "chunk-1");
assert.equal(scheduler.loadingCount, 3, "concurrency limit is enforced");
assert.equal(scheduler.peakLoadingCount, 3, "observed peak never exceeds the concurrency limit");
assert.equal(scheduler.startNextLoad(), null, "no fourth request starts while at capacity");
scheduler.completeLoad();
assert.equal(scheduler.startNextLoad().key, "chunk-2", "a slot is reused when a request finishes");
scheduler.completeLoad();
scheduler.completeLoad();
scheduler.completeLoad();
assert.equal(scheduler.loadingCount, 0, "load counter returns to zero");

const tierScheduler = new ChunkStreamingManager({ maxConcurrentLoads: 1 });
const distantVisible = { key: "visible", priorityTier: 0 };
const nearbyPrefetch = { key: "prefetch", priorityTier: 1 };
tierScheduler.enqueue(nearbyPrefetch, 0);
tierScheduler.enqueue(distantVisible, 9999);
assert.equal(tierScheduler.startNextLoad().key, "visible",
  "priority tier wins over distance when starting network requests");

// Downloads can finish in any order; visible chunks must build before prefetch.
chunks[0].priorityTier = 2;
chunks[0].priority = 10;
chunks[1].priorityTier = 0;
chunks[1].priority = 500;
chunks[2].priorityTier = 1;
chunks[2].priority = 1;
scheduler.pushReady(chunks[0], { id: 1 });
scheduler.pushReady(chunks[1], { id: 2 });
scheduler.pushReady(chunks[2], { id: 3 });
assert.equal(scheduler.readyCount, 3);
assert.deepEqual(scheduler.takeReady(1).map(item => item.raw.id), [2],
  "visible chunks build first even when their download finishes later");

// Reordering is live: a camera move can make a queued chunk visible.
chunks[0].priorityTier = 0;
chunks[0].priority = 1;
assert.deepEqual(scheduler.takeReady(1).map(item => item.raw.id), [1],
  "ready chunks are reprioritized when the camera window changes");
assert.equal(scheduler.readyCount, 1);
scheduler.remove("chunk-2");
assert.equal(scheduler.readyCount, 0, "evicted chunks are removed from the ready queue");
scheduler.enqueue(chunks[3], 3);
scheduler.remove("chunk-3");
assert.equal(scheduler.queuedCount, 0, "evicted queued chunks are not fetched");

assert.equal(resolveLodLevel(1), 0);
assert.equal(resolveLodLevel(0.7), 1);
assert.equal(resolveLodLevel(0.4), 2);
assert.equal(resolveLodLevel(0.25), 3);
assert.equal(resolveLodLevel(0.84, 0), 0, "hysteresis prevents flicker at the first threshold");
assert.equal(resolveLodLevel(0.8, 0), 1);
assert.equal(resolveLodLevel(0.56, 2), 2, "hysteresis keeps the lower-detail level until the upper threshold");

const lod = new WorldLODManager();
const visibility = () => {
  const values = {};
  const object = key => ({
    setVisible(value) { values[key] = value; }
  });
  const chunk = { key: "lod-test", lodLayers: {} };
  lod.register(chunk, "labels", object("labels"));
  lod.register(chunk, "roofDetails", object("roof"));
  lod.register(chunk, "foliage", object("foliage"));
  lod.register(chunk, "properties", object("properties"));
  const terrain = {
    tileScaleX: 0.5,
    tileScaleY: 0.5,
    setTileScale(x, y) { this.tileScaleX = x; this.tileScaleY = y; }
  };
  lod.register(chunk, "terrain", terrain);
  lod.applyChunk(chunk);
  return { values, chunk, terrain };
};

const { values, chunk, terrain } = visibility();
lod.update(0.4, [chunk]);
assert.deepEqual(values, { labels: false, roof: false, foliage: false, properties: true });
assert.equal(terrain.tileScaleX, 0.95, "intermediate LOD reduces terrain detail frequency");
lod.update(0.25, [chunk]);
assert.deepEqual(values, { labels: false, roof: false, foliage: false, properties: false });
assert.equal(terrain.tileScaleX, 1.3, "distant LOD enlarges terrain pattern to soften microdetail");
lod.update(1, [chunk]);
assert.deepEqual(values, { labels: true, roof: true, foliage: true, properties: true });
assert.equal(terrain.tileScaleX, 0.5, "close LOD restores original terrain texture scale");

console.log("Todos os testes de streaming e LOD passaram.");
