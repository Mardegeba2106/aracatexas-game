// Scheduler for chunk network requests and incremental scene builds.
export const CHUNK_STREAMING_DEFAULTS = Object.freeze({
  maxConcurrentLoads: 3,
  maxBuildsPerFrame: 1,
  reserveLimit: 16
});

export default class ChunkStreamingManager {
  constructor(options = {}) {
    this.config = { ...CHUNK_STREAMING_DEFAULTS, ...options };
    this.pending = new Map();
    this.ready = [];
    this.loadingCount = 0;
    this.peakLoadingCount = 0;
    this.sequence = 0;
  }

  get queuedCount() {
    return this.pending.size;
  }

  get readyCount() {
    return this.ready.length;
  }

  get canStartLoad() {
    return this.loadingCount < this.config.maxConcurrentLoads && this.pending.size > 0;
  }

  enqueue(chunk, priority = 0, priorityTier = chunk.priorityTier ?? 0) {
    if (!chunk?.key) return false;
    const existing = this.pending.get(chunk.key);
    this.pending.set(chunk.key, {
      chunk,
      priority: Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER,
      priorityTier: Number.isFinite(priorityTier) ? priorityTier : Number.MAX_SAFE_INTEGER,
      sequence: existing?.sequence ?? this.sequence++
    });
    return true;
  }

  reprioritize(key, priority, priorityTier) {
    const entry = this.pending.get(key);
    if (!entry) return false;
    entry.priority = Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER;
    if (Number.isFinite(priorityTier)) entry.priorityTier = priorityTier;
    return true;
  }

  comparePriority(a, b, dynamic = false) {
    const aTier = dynamic
      ? (Number.isFinite(a.chunk.priorityTier) ? a.chunk.priorityTier : 0)
      : a.priorityTier;
    const bTier = dynamic
      ? (Number.isFinite(b.chunk.priorityTier) ? b.chunk.priorityTier : 0)
      : b.priorityTier;
    if (aTier !== bTier) return aTier - bTier;

    const aPriority = dynamic
      ? (Number.isFinite(a.chunk.priority) ? a.chunk.priority : Number.MAX_SAFE_INTEGER)
      : a.priority;
    const bPriority = dynamic
      ? (Number.isFinite(b.chunk.priority) ? b.chunk.priority : Number.MAX_SAFE_INTEGER)
      : b.priority;
    return aPriority - bPriority || a.sequence - b.sequence;
  }

  startNextLoad() {
    if (!this.canStartLoad) return null;
    let bestKey = null;
    let best = null;
    for (const [key, entry] of this.pending) {
      if (!best || this.comparePriority(entry, best) < 0) {
        bestKey = key;
        best = entry;
      }
    }
    if (!best) return null;
    this.pending.delete(bestKey);
    this.loadingCount++;
    this.peakLoadingCount = Math.max(this.peakLoadingCount, this.loadingCount);
    return best.chunk;
  }

  completeLoad() {
    this.loadingCount = Math.max(0, this.loadingCount - 1);
  }

  pushReady(chunk, raw) {
    if (!chunk?.key) return false;
    this.ready.push({ chunk, raw, sequence: this.sequence++ });
    return true;
  }

  takeReady(limit = this.config.maxBuildsPerFrame) {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0 || this.ready.length === 0) return [];

    // A prioridade do chunk pode mudar enquanto o JSON aguarda na fila.
    // Ordenar no momento da construção mantém a tela à frente do tempo de resposta.
    this.ready.sort((a, b) => this.comparePriority(a, b, true));
    return this.ready.splice(0, count);
  }

  remove(key) {
    this.pending.delete(key);
    this.ready = this.ready.filter(entry => entry.chunk.key !== key);
  }
}
