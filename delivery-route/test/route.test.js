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

test('짐칸 무게: 중간 매입이 더 빠르면 중간에, 초과하면 그 순서를 버린다', () => {
  // 회사(0) — A(1) — C(2) — B(3) 일직선, 1분 간격
  const pos = [0, 1, 2, 3];
  const time = pos.map((a) => pos.map((b) => Math.abs(a - b)));
  // A 배송 5000, B 배송 2000, C 매입 4000, 최대 8000 → 7000 출발, A 후 2000, C 후 6000, B 후 4000
  const opts = { cap: 8000, initialLoad: 7000, delta: { 1: -5000, 2: 4000, 3: -2000 } };
  const r = gs.optimizeRoute([1, 2, 3], time, opts);
  assert.deepStrictEqual([...r.order], [1, 2, 3]);
  // 최대 5500: A(3000) 내린 뒤 2000, 그때 C(4000)를 실으면 6000 > 5500 → C는 B(2000) 내린 뒤
  const tight = { cap: 5500, initialLoad: 5000, delta: { 1: -3000, 2: 4000, 3: -2000 } };
  const r2 = gs.optimizeRoute([1, 2, 3], time, tight);
  // A 후 2000, C 실으면 6000 > 5500 → C는 B 다음
  assert.deepStrictEqual([...r2.order], [1, 3, 2]);
  assert.ok(gs.routeFeasible(r2.order, tight));
});

test('우선 지점은 회차 안에서 먼저 방문', () => {
  const pos = [0, 1, 2, 3];
  const time = pos.map((a) => pos.map((b) => Math.abs(a - b)));
  const r = gs.optimizeRoute([1, 2, 3], time, { priority: { 3: true } });
  assert.strictEqual(r.order[0], 3);
});

test('8곳 초과에서도 무게·우선 조건을 지킨다', () => {
  const n = 11;
  const time = randomMatrix(n + 1, 3, false);
  const pts = Array.from({ length: n }, (_, i) => i + 1);
  const delta = {};
  let init = 0;
  pts.forEach((p) => { if (p % 3 === 0) delta[p] = 1500; else { delta[p] = -1000; init += 1000; } });
  const opts = { cap: init + 500, initialLoad: init, delta, priority: { 5: true, 7: true } };
  const r = gs.optimizeRoute(pts, time, opts);
  assert.strictEqual(r.method, 'nn-2opt');
  assert.ok(gs.routeFeasible(r.order, opts));
  assert.deepStrictEqual([...r.order.slice(0, 2)].sort(), [5, 7]);
});
