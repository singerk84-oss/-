const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./load');
const { SAMPLE, VEHICLES, buildInput } = require('./fixtures');

const gs = loadGs(['config.gs', 'util.gs', 'route.gs', 'assign.gs']);

function tripCount(res) {
  const c = {};
  res.trips.forEach((t) => { c[t.vehicleId] = (c[t.vehicleId] || 0) + 1; });
  return c;
}

test('예시 데이터: 1톤 2회, 5톤 3회, 10톤 1회 → 회차 6개, 모두 18:00 이전 복귀', () => {
  const res = gs.planDeliveries(buildInput(SAMPLE));
  assert.deepStrictEqual(tripCount(res), { V1: 2, V5: 3, V10: 1 });
  assert.strictEqual(res.trips.length, 6);
  res.trips.forEach((t) => assert.ok(t.returnMin <= 1080, `${t.vehicleId}-${t.trip} 복귀 ${t.returnMin}`));
  assert.strictEqual(res.warnings.length, 0);
  res.rows.forEach((r) => {
    assert.ok(r.vehicleId, r.id + ' 미배정');
    assert.strictEqual(r.warnings.length, 0, r.id + ': ' + r.warnings.join());
  });
});

test('회차는 차량별로 겹치지 않게 순서대로 이어지고, 회차 번호는 1부터', () => {
  const res = gs.planDeliveries(buildInput(SAMPLE));
  for (const v of VEHICLES) {
    const mine = res.trips.filter((t) => t.vehicleId === v.id);
    mine.forEach((t, k) => {
      assert.strictEqual(t.trip, k + 1);
      assert.strictEqual(t.loadStartMin, k === 0 ? 480 : mine[k - 1].returnMin);
      assert.strictEqual(t.departMin, t.loadStartMin + 30);
    });
  }
});

test('중량 합계가 차량 최대적재중량을 넘는 회차가 없다', () => {
  const res = gs.planDeliveries(buildInput(SAMPLE));
  const w = Object.fromEntries(SAMPLE.map((r) => [r[0], r[3]]));
  const cap = Object.fromEntries(VEHICLES.map((v) => [v.id, v.maxWeight]));
  res.trips.forEach((t) => {
    const sum = t.order.reduce((s, id) => s + w[id], 0);
    assert.ok(sum <= cap[t.vehicleId]);
  });
});

test('길이 초과 화물은 해당 차량에 배정되지 않는다', () => {
  // 가벼워도 3500mm라 1톤(2800mm)에는 실을 수 없다
  const list = [['긴자재', 5, 5, 300, 3500], ['짧은자재', -5, 5, 300, 1500]];
  const res = gs.planDeliveries(buildInput(list));
  const long = res.rows.find((r) => r.id === '긴자재');
  assert.notStrictEqual(long.vehicleId, 'V1');
  assert.ok(long.vehicleId);
});

test('실을 수 있는 차량이 없으면 경고', () => {
  const list = [['초장척', 5, 5, 300, 12000]];
  const res = gs.planDeliveries(buildInput(list));
  assert.strictEqual(res.rows[0].vehicleId, '');
  assert.match(res.rows[0].warnings.join(), /길이 초과/);
  assert.match(res.warnings.join(), /배정 불가/);
});

test('18:00 안에 끝낼 수 없으면 차량 추가 필요 경고', () => {
  // 10톤만 실을 수 있는 원거리 화물 2건 → 10톤 1대로는 하루에 끝낼 수 없다
  const list = [['원거리1', 240, 0, 9500, 8000], ['원거리2', -240, 0, 9500, 8000]];
  const res = gs.planDeliveries(buildInput(list));
  assert.match(res.warnings.join(), /차량 추가 필요/);
  const warned = res.rows.filter((r) => /차량 추가 필요/.test(r.warnings.join()));
  assert.ok(warned.length >= 1);
});

test('수동지정 행은 배정차량·회차를 유지한다', () => {
  const input = buildInput(SAMPLE, {
    overrides: { 근거리A: { manual: true, vehicleId: 'V5', trip: 2 } }
  });
  const res = gs.planDeliveries(input);
  const a = res.rows.find((r) => r.id === '근거리A');
  assert.strictEqual(a.vehicleId, 'V5');
  assert.strictEqual(a.trip, 2);
  // 같은 차량의 자동 회차는 2번을 피해 번호가 매겨진다
  const v5 = res.trips.filter((t) => t.vehicleId === 'V5').map((t) => t.trip);
  assert.strictEqual(new Set(v5).size, v5.length);
  assert.ok(v5.includes(2));
});

test('예상도착시각은 출발(상차 후) + 이동 + 앞 업체 체류 순으로 누적', () => {
  const list = [['P', 10, 0, 100, 1000], ['Q', 20, 0, 100, 1000]];
  const res = gs.planDeliveries(buildInput(list, { vehicles: [VEHICLES[0]] }));
  assert.strictEqual(res.trips.length, 1);
  const p = res.rows.find((r) => r.id === 'P');
  const q = res.rows.find((r) => r.id === 'Q');
  assert.strictEqual(p.seq, 1);
  assert.strictEqual(p.etaMin, 480 + 30 + 10);
  assert.strictEqual(q.etaMin, p.etaMin + 30 + 10);
  assert.strictEqual(res.trips[0].returnMin, q.etaMin + 30 + 20);
});

test('차량별 행렬: 같은 구간도 차량마다 다른 시간으로 예상도착시각 계산', () => {
  const list = [['P', 10, 0, 100, 1000]];
  const input = buildInput(list, { vehicles: [VEHICLES[2]] });
  // 10톤은 높이 제한 우회로 2배 걸린다고 가정
  input.timeByVehicle = { V10: input.time.map((r) => r.map((x) => x * 2)) };
  const res = gs.planDeliveries(input);
  assert.strictEqual(res.rows[0].etaMin, 480 + 30 + 20);
});

test('진입 경로가 없는 차량은 후보에서 빠진다', () => {
  const list = [['골목상가', 5, 5, 800, 2000]];
  const input = buildInput(list);
  const blocked = input.time.map((r) => r.slice());
  blocked[0][1] = Infinity;
  blocked[1][0] = Infinity;
  // 1톤은 못 들어가고 5톤·10톤은 들어간다고 가정
  input.timeByVehicle = { V1: blocked, V5: input.time, V10: input.time };
  const res = gs.planDeliveries(input);
  assert.notStrictEqual(res.rows[0].vehicleId, 'V1');
  assert.ok(res.rows[0].vehicleId);
});

test('실을 수 있는 차량이 모두 진입 불가면 경고', () => {
  const list = [['초중량', 5, 5, 9500, 8000]]; // 10톤만 실을 수 있음
  const input = buildInput(list);
  const blocked = input.time.map((r) => r.slice());
  blocked[0][1] = Infinity;
  input.timeByVehicle = { V10: blocked };
  const res = gs.planDeliveries(input);
  assert.strictEqual(res.rows[0].vehicleId, '');
  assert.match(res.rows[0].warnings.join(), /진입할 경로 없음/);
});
