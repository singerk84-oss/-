// TMAP 화물차 경로 호출 형식, 프로필별 캐시, 진입 불가 처리
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gas-mock');

function load(props, responder) {
  const g = createGas({ props });
  const calls = [];
  g.ctx.UrlFetchApp = {
    fetch: (url, opt) => {
      const body = JSON.parse(opt.payload);
      calls.push({ url, opt, body });
      const r = responder(body);
      return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.json) };
    }
  };
  const v = vm.createContext(g.ctx);
  for (const f of ['config.gs', 'util.gs', 'sheets.gs', 'geocode.gs', 'matrix.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), v, { filename: f });
  }
  return { g, v, calls };
}

const ok = (dist, time) => ({ code: 200, json: { type: 'FeatureCollection', features: [{ properties: { totalDistance: dist, totalTime: time } }] } });
const pts = [{ lat: 36.5, lng: 127.5 }, { lat: 36.6, lng: 127.6 }];
const truck = { '차량ID': 'V10', '최대적재중량(kg)': 10000, '차량높이(cm)': 350, '차량폭(cm)': 249, '차량길이(cm)': 1150, '차량총중량(kg)': 20000, 'TMAP차종': '5' };

test('TMAP 화물차 요청: appKey 헤더, 경도·위도, 차량 제원 전달, 요약 응답 해석', () => {
  const { v, calls } = load({ TMAP_APP_KEY: 'test-key' }, () => ok(12345, 900));
  const prof = v.vehicleProfile_(truck);
  const m = v.buildMatrix('2026-11-17', pts, prof);
  assert.strictEqual(calls.length, 2);
  const c = calls[0];
  assert.match(c.url, /^https:\/\/apis\.openapi\.sk\.com\/tmap\/truck\/routes\?version=1/);
  assert.strictEqual(c.opt.method, 'post');
  assert.strictEqual(c.opt.headers.appKey, 'test-key');
  assert.deepStrictEqual(
    { x: c.body.startX, y: c.body.startY, ex: c.body.endX, ey: c.body.endY },
    { x: '127.5', y: '36.5', ex: '127.6', ey: '36.6' });
  assert.strictEqual(c.body.truckHeight, '350');
  assert.strictEqual(c.body.truckWidth, '249');
  assert.strictEqual(c.body.truckLength, '1150');
  assert.strictEqual(c.body.truckWeight, '10000');
  assert.strictEqual(c.body.truckTotalWeight, '20000');
  assert.strictEqual(c.body.truckType, '5');
  assert.strictEqual(m.time[0][1], 15);
  assert.strictEqual(m.dist[0][1], 12.345);
});

test('같은 날 같은 프로필은 캐시 재사용, 프로필이 같은 차량은 행렬 공유', () => {
  const { v, calls } = load({ TMAP_APP_KEY: 'k' }, () => ok(1000, 60));
  const vehicles = [
    { id: 'A', profile: v.vehicleProfile_(truck) },
    { id: 'B', profile: v.vehicleProfile_(truck) },
    { id: 'C', profile: v.vehicleProfile_({ ...truck, '차량높이(cm)': 200 }) }
  ];
  const mats = v.buildVehicleMatrices('2026-11-17', pts, vehicles);
  assert.strictEqual(calls.length, 4); // 프로필 2개 × 구간 2개
  assert.strictEqual(mats.A, mats.B);
  vm.runInContext("legMemo_ = null", v); // 새 실행 — 구간캐시 시트에서 읽는다
  v.buildVehicleMatrices('2026-11-17', pts, vehicles);
  assert.strictEqual(calls.length, 4, '두 번째 실행은 API를 부르지 않는다');
});

test('경로를 못 찾은 구간은 Infinity(진입 불가), 전부 실패하면 오류', () => {
  let n = 0;
  const { v } = load({ TMAP_APP_KEY: 'k' }, () => (n++ === 0 ? { code: 400, json: { error: { code: 'NO_ROUTE' } } } : ok(1000, 60)));
  const m = v.buildMatrix('2026-11-17', pts, v.vehicleProfile_(truck));
  assert.strictEqual(m.time[0][1], Infinity);
  assert.strictEqual(m.time[1][0], 1);
  assert.strictEqual(m.failed.length, 1);

  const all = load({ TMAP_APP_KEY: 'k' }, () => ({ code: 401, json: { error: 'invalid key' } }));
  assert.throws(() => all.v.buildMatrix('2026-11-17', pts, all.v.vehicleProfile_(truck)), /화물차경로 실패/);
});

test('TMAP 키가 없으면 바로 중단', () => {
  const { v } = load({}, () => ok(1, 1));
  assert.throws(() => v.buildMatrix('2026-11-17', pts, v.vehicleProfile_(truck)), /TMAP_APP_KEY/);
});

test('제원이 비면 경고 문구', () => {
  const { v } = load({ TMAP_APP_KEY: 'k' }, () => ok(1, 1));
  const w = v.profileWarnings_('V1', v.vehicleProfile_({ '차량ID': 'V1' }));
  assert.match(w.join(), /TMAP차종.*차량높이.*차량총중량/);
});
