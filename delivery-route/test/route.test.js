const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./load');

const gs = loadGs(['config.gs', 'util.gs', 'route.gs']);

// 무작위 대칭/비대칭 행렬 생성(시드 고정)
function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
function randomMatrix(n, seed, asym) {
  const r = rng(seed);
  const pts = Array.from({ length: n }, () => [r() * 50, r() * 50]);
  return pts.map((a, i) => pts.map((b, j) => {
    if (i === j) return 0;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    return asym ? d * (1 + r() * 0.3) : d;
  }));
}
function bruteForce(points, time) {
  let best = Infinity;
  const perm = (arr, l) => {
    if (l === arr.length) { best = Math.min(best, gs.tourTime(arr, time)); return; }
    for (let i = l; i < arr.length; i++) {
      [arr[l], arr[i]] = [arr[i], arr[l]];
      perm(arr, l + 1);
      [arr[l], arr[i]] = [arr[i], arr[l]];
    }
  };
  perm(points.slice(), 0);
  return best;
}

test('8곳 이하는 전수 탐색과 같은 최단 시간', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const n = 2 + (seed % 7); // 2..8곳
    const time = randomMatrix(n + 1, seed, seed % 2 === 0);
    const pts = Array.from({ length: n }, (_, i) => i + 1);
    const r = gs.optimizeRoute(pts, time);
    assert.strictEqual(r.method, 'exact');
    assert.strictEqual(r.order.length, n);
    assert.ok(Math.abs(r.travelMin - bruteForce(pts, time)) < 1e-9);
    assert.ok(Math.abs(r.travelMin - gs.tourTime(r.order, time)) < 1e-9);
  }
});

test('8곳 초과는 최근접 이웃 + 2-opt로 모든 지점을 한 번씩 방문', () => {
  const time = randomMatrix(13, 7, false);
  const pts = Array.from({ length: 12 }, (_, i) => i + 1);
  const r = gs.optimizeRoute(pts, time);
  assert.strictEqual(r.method, 'nn-2opt');
  assert.deepStrictEqual([...r.order].sort((a, b) => a - b), pts);
  assert.ok(Math.abs(r.travelMin - gs.tourTime(r.order, time)) < 1e-9);
});

test('시각 변환', () => {
  assert.strictEqual(gs.toMinutes('08:00'), 480);
  assert.strictEqual(gs.toMinutes(0.75), 1080);
  assert.strictEqual(gs.formatMinutes(1085), '18:05');
});
