export function toWorld(point, pixelsPerMeter) {
  return {
    x: point[0] * pixelsPerMeter,
    y: -point[1] * pixelsPerMeter
  };
}

export function pointInRing(point, ring) {
  let inside = false;
  const x = point.x, y = point.y;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const crosses = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point, rings) {
  if (!rings?.length || !pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

export function polygonBounds(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function polygonCentroid(ring) {
  let area2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const cross = a.x * b.y - b.x * a.y;
    area2 += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area2) < 1e-5) {
    return {
      x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
      y: ring.reduce((s, p) => s + p.y, 0) / ring.length
    };
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) };
}

export function getFeaturePolygons(feature, pixelsPerMeter) {
  return feature.polygons.map(poly => poly.map(ring =>
    ring.map(p => toWorld(p, pixelsPerMeter))
  ));
}
