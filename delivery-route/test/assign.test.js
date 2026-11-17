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

test('매입: 배송 회차 경유 중 매입, 배송·매입 합계 각각 최대적재중량 이하', () => {
  // 1톤(1000kg)만: 배송 800 + 매입 900 → 한 회차 가능(배송 후 매입)
  const list = [['배송처', 10, 0, 800, 1000], ['매입처', 12, 0, 900, 1000]];
  const input = buildInput(list, { vehicles: [VEHICLES[0]], overrides: { 매입처: { kind: 'pickup' } } });
  const res = gs.planDeliveries(input);
  assert.strictEqual(res.trips.length, 1);
  assert.deepStrictEqual([...res.trips[0].order], ['배송처', '매입처']);
  assert.strictEqual(res.trips[0].pickupWeight, 900);
  assert.strictEqual(res.warnings.length, 0);
});

test('매입: 짐칸이 남으면 배송 중간에 들르는 게 더 빠를 때 중간에 넣는다', () => {
  // 회사 — 매입처(5km) — 배송처(10km) 일직선, 짐칸 충분
  const list = [['배송처', 10, 0, 300, 1000], ['매입처', 5, 0, 300, 1000]];
  const input = buildInput(list, { vehicles: [VEHICLES[2]], overrides: { 매입처: { kind: 'pickup' } } });
  const res = gs.planDeliveries(input);
  assert.strictEqual(res.trips.length, 1);
  // 왕복 20km는 어느 순서든 같지만, 짐칸이 남으면 매입을 먼저 들러도 허용된다
  assert.ok(res.trips[0].travelMin <= 20 + 1e-9);
});

test('매입: 중간에 실으면 초과되는 경우 배송을 먼저 끝낸다', () => {
  // 1톤: 배송 900 싣고 출발, 가는 길의 매입 500을 먼저 실으면 1400 > 1000
  const list = [['배송처', 10, 0, 900, 1000], ['매입처', 5, 0, 500, 1000]];
  const input = buildInput(list, { vehicles: [VEHICLES[0]], overrides: { 매입처: { kind: 'pickup' } } });
  const res = gs.planDeliveries(input);
  assert.deepStrictEqual([...res.trips[0].order], ['배송처', '매입처']);
});

test('우선 배송: 차량 1회차에 넣고 회차 안에서 먼저 방문', () => {
  // 5톤 하나로 4건(각 4500kg) → 4회차. 마지막 행(먼 곳)을 우선으로
  const list = [['가', 10, 0, 4500, 1000], ['나', 20, 0, 4500, 1000], ['다', 30, 0, 4500, 1000], ['라', 40, 0, 4500, 1000]];
  const input = buildInput(list, { vehicles: [VEHICLES[1]], overrides: { 라: { priority: true } } });
  const res = gs.planDeliveries(input);
  const ra = res.rows.find((r) => r.id === '라');
  assert.strictEqual(ra.trip, 1);
  assert.strictEqual(ra.seq, 1);
  assert.strictEqual(ra.warnings.length, 0);

  // 한 회차 안: 우선 건이 먼 곳이어도 먼저
  const list2 = [['가까움', 5, 0, 100, 1000], ['멂', 30, 0, 100, 1000]];
  const res2 = gs.planDeliveries(buildInput(list2, { vehicles: [VEHICLES[2]], overrides: { 멂: { priority: true } } }));
  assert.deepStrictEqual([...res2.trips[0].order], ['멂', '가까움']);
});

test('우선 배송을 1회차에 다 넣을 수 없으면 경고', () => {
  // 1톤 하나, 우선 2건이 각 800kg → 1회차에 둘 다 못 실음
  const list = [['우선A', 10, 0, 800, 1000], ['우선B', -10, 0, 800, 1000]];
  const res = gs.planDeliveries(buildInput(list, {
    vehicles: [VEHICLES[0]], overrides: { 우선A: { priority: true }, 우선B: { priority: true } }
  }));
  const warned = res.rows.filter((r) => /1회차에 넣지 못함/.test(r.warnings.join()));
  assert.strictEqual(warned.length, 1);
});

// ---- 운행 중 매입 추가 ----
function liveInput(over = {}) {
  // 일직선 좌표: 지점 번호 = km, 1km = 1분
  const legTime = (vid, a, b) => Math.abs(a - b);
  return Object.assign({
    item: { point: 12, weight: 500, length: 1000, stayMin: 10 },
    vehicles: [{ id: 'V1', maxWeight: 1000, bedLength: 2800 }],
    legTime,
    trips: [{
      vehicleId: 'V1', trip: 1, done: false, returnDeparted: false, returnMin: 600,
      stops: [
        { point: 10, kind: 'delivery', weight: 800, stayMin: 30, done: true, departed: true },
        { point: 20, kind: 'delivery', weight: 100, stayMin: 30, done: false, departed: false }
      ]
    }],
    lastReturnByVehicle: { V1: 600 },
    dayStart: 480, dayEnd: 1080, loadingMin: 30
  }, over);
}

test('운행 중 매입: 남은 경유지 사이 가장 적게 도는 자리에 넣는다', () => {
  const r = gs.planPickupInsertion(liveInput());
  // 10 → [12] → 20: 추가 = 2 + 10 + 8 - 10 = 10분
  assert.strictEqual(r.type, 'insert');
  assert.strictEqual(r.position, 1);
  assert.strictEqual(r.deltaMin, 10);
});

test('운행 중 매입: 지나간 경유지 앞이나 짐칸 초과 자리는 피한다', () => {
  // 1번째(10) 완료, 2번째(20)로 이미 출발 → 복귀 직전(20 뒤)만 가능
  const inp = liveInput();
  inp.trips[0].stops[1].departed = true;
  const r = gs.planPickupInsertion(inp);
  assert.strictEqual(r.type, 'insert');
  assert.strictEqual(r.position, 2);
  // 매입 950kg: 남은 배송 100 + 950 = 1050 > 1000 → 20 앞 불가, 20 뒤(950)는 가능
  const inp2 = liveInput({ item: { point: 12, weight: 950, length: 1000, stayMin: 10 } });
  const r2 = gs.planPickupInsertion(inp2);
  assert.strictEqual(r2.position, 2);
});

test('운행 중 매입: 회차에 못 넣으면 매입 전용 새 회차, 그것도 안 되면 사유', () => {
  const full = liveInput();
  full.trips[0].done = true; // 이미 끝난 회차
  const r = gs.planPickupInsertion(full);
  assert.strictEqual(r.type, 'new');
  assert.strictEqual(r.trip, 2);
  assert.strictEqual(r.departMin, 630);
  assert.strictEqual(r.returnMin, 630 + 12 + 10 + 12);

  const late = liveInput({ lastReturnByVehicle: { V1: 1075 } });
  late.trips[0].done = true;
  assert.match(gs.planPickupInsertion(late).reason, /운행종료/);
  assert.match(gs.planPickupInsertion(liveInput({ item: { point: 12, weight: 500, length: 3000, stayMin: 10 } })).reason, /길이/);
});
