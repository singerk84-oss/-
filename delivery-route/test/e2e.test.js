// 통합 시험: 시트 템플릿 → 예시 데이터 → 배차·경로 → 링크 → 웹앱 완료 처리 → 일일마감
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gas-mock');

const FILES = ['config.gs', 'util.gs', 'sheets.gs', 'geocode.gs', 'matrix.gs', 'route.gs', 'assign.gs',
  'links.gs', 'notify.gs', 'log.gs', 'webapp.gs', 'main.gs', 'live.gs'];

function setup() {
  const g = createGas({ props: { ROUTE_PROVIDER: 'estimate' } });
  const alerts = [];
  g.ctx.SpreadsheetApp.getUi = () => ({ alert: (m) => alerts.push(m) });
  g.ctx.HtmlService = {
    createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, kind: 'tpl' }) }),
    createHtmlOutput: (h) => ({ setTitle() { return this; }, addMetaTag() { return this; }, html: h })
  };
  const vctx = vm.createContext(g.ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), vctx, { filename: f });

  // 드라이브의 시트 템플릿과 같은 구성
  const settings = g.ss.insertSheet('설정');
  settings.getRange(1, 1, 8, 3).setValues([
    ['항목', '값', '비고'], ['회사주소', '(시험) 회사', '출발·복귀지'], ['회사위도', 36.5, ''], ['회사경도', 127.5, ''],
    ['운행시작', '08:00', ''], ['운행종료', '18:00', ''], ['상차시간(분)', 30, ''], ['기본체류시간(분)', 30, '']
  ]);
  const H = vctx.HEADERS;
  [['거래처', H.CUSTOMERS], ['차량', H.VEHICLES], ['오늘배송', H.TODAY], ['운행일지', H.LOG], ['일일마감', H.CLOSE]]
    .forEach(([n, h]) => g.ss.insertSheet(n).getRange(1, 1, 1, h.length).setValues([h]));
  return { g, vctx, alerts };
}

function table(vctx, name) {
  return JSON.parse(vm.runInContext(`JSON.stringify(readTable_(${JSON.stringify(name)}))`, vctx));
}

test('예시 데이터로 회차 6개·링크 6개, 웹앱 완료 처리, 일일마감까지', () => {
  const { g, vctx, alerts } = setup();
  vctx.menuCheckTemplate();
  vctx.menuSample();
  vctx.menuPlan();
  assert.match(alerts.at(-1), /회차 6개, 링크 6개 생성/, alerts.at(-1));
  assert.doesNotMatch(alerts.at(-1), /경고/);

  const trips = table(vctx, '회차');
  assert.strictEqual(trips.length, 6);
  const count = {};
  trips.forEach((t) => { count[t['차량ID']] = (count[t['차량ID']] || 0) + 1; });
  assert.deepStrictEqual(count, { V1: 2, V5: 3, V10: 1 });
  trips.forEach((t) => {
    assert.ok(t['복귀예정'] <= '18:00', t['복귀예정']);
    assert.match(t['링크'], /^https:\/\/script\.google\.com\/macros\/s\/TEST\/exec\?d=2026-11-16&v=V\d+&t=\d&s=[\w-]{22}$/);
  });

  // 오늘배송: 모든 행 배정, 경고 없음, 길이 4000mm 화물은 1톤(2800mm)에 없음
  const today = table(vctx, '오늘배송');
  today.forEach((r) => {
    assert.ok(r['배정차량ID'], r['거래처명']);
    assert.strictEqual(r['경고'], '');
    if (r['화물최대길이(mm)'] > 2800) assert.notStrictEqual(r['배정차량ID'], 'V1');
  });

  // 운행일지: 회차별 배송지 + 회사 복귀 행
  const log = table(vctx, '운행일지');
  assert.strictEqual(log.length, 6 + 6);

  // 웹앱: 잘못된 토큰은 거부
  const link = new URL(trips.find((t) => t['차량ID'] === 'V10')['링크']);
  const p = Object.fromEntries(link.searchParams);
  assert.strictEqual(vctx.doGet({ parameter: { ...p, s: 'x'.repeat(22) } }).html.includes('잘못된 링크'), true);
  assert.strictEqual(vctx.doGet({ parameter: p }).kind, 'tpl');
  assert.throws(() => vctx.getTripState({ ...p, t: '2' }), /잘못된 링크/);

  // 10톤 1회차: 원거리공장 → 회사 복귀
  let st = vctx.getTripState(p);
  assert.strictEqual(st.stops.length, 2);
  assert.strictEqual(st.current, 0);
  assert.strictEqual(st.isLastTrip, true);
  assert.match(st.stops[0].nav.main, /^tmap:\/\/route\?goalname=/);
  assert.strictEqual(st.stops[0].nav.alt, undefined, '카카오맵 보조 링크 없음');

  assert.throws(() => vctx.tapStop(p, 0, 'complete'), /출발을 기록/);
  assert.throws(() => vctx.tapStop(p, 1, 'start'), /차례/);

  g.clock.now = new Date('2026-11-16T08:30:00+09:00');
  st = vctx.tapStop(p, 0, 'start');
  assert.strictEqual(st.stops[0].depart, '08:30');
  g.clock.now = new Date('2026-11-16T12:20:00+09:00');
  st = vctx.tapStop(p, 0, 'complete');
  assert.strictEqual(st.stops[0].arrive, '12:20');
  assert.strictEqual(st.stops[0].complete, '12:20');
  assert.strictEqual(st.current, 1, '다음 차례로 넘어감');
  assert.throws(() => vctx.submitClose(p, 1000), /복귀까지 완료/);

  g.clock.now = new Date('2026-11-16T12:30:00+09:00');
  vctx.tapStop(p, 1, 'start');
  g.clock.now = new Date('2026-11-16T16:40:00+09:00');
  vctx.tapStop(p, 1, 'arrive');
  g.clock.now = new Date('2026-11-16T16:45:00+09:00');
  st = vctx.tapStop(p, 1, 'complete');
  assert.strictEqual(st.tripDone, true);
  assert.strictEqual(st.stops[1].arrive, '16:40');

  const logV10 = table(vctx, '운행일지').filter((r) => r['차량ID'] === 'V10');
  assert.deepStrictEqual(logV10.map((r) => [r['출발시각'], r['도착시각'], r['완료시각']]),
    [['08:30', '12:20', '12:20'], ['12:30', '16:40', '16:45']]);
  assert.strictEqual(table(vctx, '회차').find((t) => t['차량ID'] === 'V10')['상태'], '완료');

  // 일일마감: 전일 기록이 있으면 실주행·차이 계산
  g.ss.getSheetByName('일일마감').appendRow(['2026-11-15', 'V10', 100000, '', '', '']);
  const apiSum = logV10.reduce((s, r) => s + r['구간거리(API,km)'], 0);
  st = vctx.submitClose(p, 100330);
  assert.strictEqual(st.closed.real, 330);
  assert.ok(Math.abs(st.closed.api - Math.round(apiSum * 10) / 10) < 1e-9);
  assert.ok(Math.abs(st.closed.diff - Math.round((330 - st.closed.api) * 10) / 10) < 1e-9);
  assert.throws(() => vctx.submitClose(p, 100400), /이미 오늘 마감/);

  // 운행 시작 후 재계산은 막는다
  vctx.menuPlan();
  assert.match(alerts.at(-1), /재계산할 수 없습니다/);
});

test('마지막 회차가 아니면 마감 불가, 전송(email 모드)은 회차 6건', () => {
  const { g, vctx } = setup();
  vctx.menuSample();
  vctx.menuPlan();
  const t1 = table(vctx, '회차').find((t) => t['차량ID'] === 'V5' && t['회차'] === 1);
  const p = Object.fromEntries(new URL(t1['링크']).searchParams);
  assert.strictEqual(vctx.getTripState(p).isLastTrip, false);
  assert.throws(() => vctx.submitClose(p, 1), /마지막 회차/);

  const r = vctx.sendTripLinks('2026-11-16');
  assert.strictEqual(r.sent, 6);
  assert.strictEqual(g.mails.length, 1);
  assert.match(g.mails[0].body, /V5 예시|5톤 예시/);
  assert.ok(table(vctx, '회차').every((t) => t['전송시각']));
});

test('카카오 키가 없으면 구글 지오코더로 회사·거래처 좌표를 채운다', () => {
  const { g, vctx } = setup();
  const sh = g.ss.getSheetByName('설정');
  sh.set(3, 2, ''); sh.set(4, 2, ''); // 회사 좌표 비움
  g.ss.getSheetByName('거래처').appendRow(['테스트상사', '경기도 시흥시 어딘가 1', '', '', '']);
  g.ctx.Maps = { newGeocoder: () => ({ setRegion() { return this; }, setLanguage() { return this; },
    geocode: (a) => ({ status: 'OK', results: [{ geometry: { location: { lat: 37.34, lng: 126.73 } } }] }) }) };
  const r = vctx.geocodeAll();
  assert.strictEqual(r.done, 2);
  assert.strictEqual(sh.data[2][1], 37.34);
  const c = table(vctx, '거래처')[0];
  assert.strictEqual(c['위도'], 37.34);
  assert.strictEqual(c['체류시간(분)'], 30);
});

test('설정 시트의 경로제공자·웹앱URL 값을 스크립트 속성 대신 쓴다', () => {
  const { g, vctx } = setup();
  delete g.store.ROUTE_PROVIDER;
  g.ss.getSheetByName('설정').appendRow(['경로제공자', 'estimate', '']);
  g.ss.getSheetByName('설정').appendRow(['웹앱URL', 'https://script.google.com/macros/s/DEPLOY/exec', '']);
  vm.runInContext('sheetConfigMemo_ = null', vctx);
  assert.strictEqual(vctx.routeProvider_(), 'estimate');
  assert.match(vctx.buildTripLink_('2026-11-17', 'V1', '1'), /^https:\/\/script\.google\.com\/macros\/s\/DEPLOY\/exec\?/);
});

test('회차 탭에 경유지가 표시되고 완료된 경유지는 녹색', () => {
  const { g, vctx } = setup();
  vctx.menuSample();
  vctx.menuPlan();
  const sh = g.ss.getSheetByName('회차');
  const head = sh.data[0];
  const wp1 = head.indexOf('경유지1') + 1;
  assert.ok(wp1 > 0, '경유지1 컬럼 생성');
  const trips = table(vctx, '회차');
  const t = trips.find((x) => x['차량ID'] === 'V10');
  assert.match(t['경유지1'], /^예시-원거리공장 \(예정 \d\d:\d\d\)$/);
  assert.strictEqual(sh.bg[t._row + ',' + wp1] || null, null);

  const p = Object.fromEntries(new URL(t['링크']).searchParams);
  vctx.tapStop(p, 0, 'start');
  assert.strictEqual(sh.bg[t._row + ',' + wp1] || null, null, '출발만 했을 때는 색 없음');
  g.clock.now = new Date('2026-11-16T12:20:00+09:00');
  vctx.tapStop(p, 0, 'complete');
  assert.strictEqual(sh.bg[t._row + ',' + wp1], '#c6efce');
  assert.match(table(vctx, '회차').find((x) => x['차량ID'] === 'V10')['경유지1'], /✓12:20$/);

  // 회사 복귀까지 끝나면 상태 칸도 녹색
  vctx.tapStop(p, 1, 'start');
  vctx.tapStop(p, 1, 'complete');
  const statusCol = head.indexOf('상태') + 1;
  assert.strictEqual(sh.bg[t._row + ',' + statusCol], '#c6efce');

  // 다른 회차 경유지는 그대로
  const other = table(vctx, '회차').find((x) => x['차량ID'] === 'V5');
  assert.strictEqual(sh.bg[other._row + ',' + wp1] || null, null);
});

test('배차 계산 때 구간캐시의 지난 날짜 행을 자동 삭제', () => {
  const { g, vctx } = setup();
  vctx.menuCheckTemplate();
  const cache = g.ss.getSheetByName('구간캐시');
  cache.appendRow(['2026-11-10', 'estimate', '1,1', '2,2', 100, 10, 'estimate']);
  cache.appendRow(['2026-11-15', 'estimate', '1,1', '2,2', 100, 10, 'estimate']);
  cache.appendRow(['2026-11-16', 'estimate', '9,9', '8,8', 100, 10, 'estimate']);
  vctx.menuSample();
  vctx.menuPlan();
  const dates = table(vctx, '구간캐시').map((r) => r['일자']);
  assert.ok(dates.length > 1);
  assert.ok(dates.every((d) => d === '2026-11-16'), '오늘 것만 남음: ' + [...new Set(dates)]);
  assert.ok(table(vctx, '구간캐시').some((r) => r['출발좌표'] === '9,9'), '오늘 기존 캐시는 유지');

  // 보관일수 2 → 11-14 이후는 남긴다
  cache.appendRow(['2026-11-14', 'estimate', '1,1', '2,2', 100, 10, 'estimate']);
  cache.appendRow(['2026-11-13', 'estimate', '1,1', '2,2', 100, 10, 'estimate']);
  g.ss.getSheetByName('설정').appendRow(['구간캐시보관일수', 2, '']);
  vm.runInContext('sheetConfigMemo_ = null', vctx);
  assert.strictEqual(vctx.pruneLegCache_('2026-11-16'), 1);
  assert.ok(table(vctx, '구간캐시').some((r) => r['일자'] === '2026-11-14'));
});

test('배차 계산: 오늘배송 구분=매입·우선 반영, 운행일지·기사 화면 표시', () => {
  const { g, vctx } = setup();
  vctx.menuSample();
  // 근거리A 근처 매입처 추가, 근거리B를 우선으로
  const s = { lat: 36.5, lng: 127.5 };
  g.ss.getSheetByName('거래처').appendRow(['예시-매입처', '(예시)', s.lat + 0.05, s.lng + 0.05, 20]);
  const today = g.ss.getSheetByName('오늘배송');
  vctx.ensureOptionalColumns_();
  const H = today.data[0];
  const kindCol = H.indexOf('구분') + 1;
  const priCol = H.indexOf('우선') + 1;
  assert.ok(kindCol > 0 && priCol > 0, '구분·우선 컬럼 추가');
  const rowB = today.data.findIndex((r) => r[1] === '예시-근거리B') + 1;
  today.set(rowB, priCol, true);
  const r = today.getLastRow() + 1;
  today.set(r, 1, '2026-11-16'); today.set(r, 2, '예시-매입처'); today.set(r, 3, 300); today.set(r, 4, 1500);
  today.set(r, kindCol, '매입');
  vctx.menuPlan();

  const rows = table(vctx, '오늘배송');
  const pick = rows.find((x) => x['거래처명'] === '예시-매입처');
  assert.ok(pick['배정차량ID'], '매입 배정');
  const b = rows.find((x) => x['거래처명'] === '예시-근거리B');
  assert.strictEqual(b['회차'], 1);
  assert.strictEqual(b['방문순서'], 1);

  const logPick = table(vctx, '운행일지').find((x) => x['거래처명'] === '예시-매입처');
  assert.strictEqual(logPick['구분'], '매입');

  const trip = table(vctx, '회차').find((x) => x['차량ID'] === pick['배정차량ID'] && x['회차'] === pick['회차']);
  const p = Object.fromEntries(new URL(trip['링크']).searchParams);
  const st = vctx.getTripState(p);
  const ps = st.stops.find((x) => x.name === '예시-매입처');
  assert.strictEqual(ps.isPickup, true);
  const wps = Object.keys(trip).filter((k) => k.startsWith('경유지')).map((k) => trip[k]).join('|');
  assert.match(wps, /\[매입\] 예시-매입처/);
  const tripB = table(vctx, '회차').find((x) => x['차량ID'] === b['배정차량ID'] && x['회차'] === 1);
  assert.match(tripB['경유지1'], /^★예시-근거리B/);
});

test('운행 중 매입 추가: 복귀 중인 회차의 복귀 직전에 끼워 넣고 같은 링크로 이어서 진행', () => {
  const { g, vctx, alerts } = setup();
  vctx.menuSample();
  vctx.menuPlan();
  const t10 = table(vctx, '회차').find((x) => x['차량ID'] === 'V10');
  const p = Object.fromEntries(new URL(t10['링크']).searchParams);
  // 원거리공장 완료 후 회사로 복귀 출발
  g.clock.now = new Date('2026-11-16T08:30:00+09:00'); vctx.tapStop(p, 0, 'start');
  g.clock.now = new Date('2026-11-16T12:20:00+09:00'); vctx.tapStop(p, 0, 'complete');
  g.clock.now = new Date('2026-11-16T12:30:00+09:00'); vctx.tapStop(p, 1, 'start');

  // 원거리공장과 회사 사이(동쪽 60km)에 매입처 추가 — 10톤 복귀길에 딱 맞는 위치
  const kmLng = 1 / (111 * Math.cos(36.5 * Math.PI / 180));
  g.ss.getSheetByName('거래처').appendRow(['예시-귀사길매입', '(예시)', 36.5, 127.5 + 60 * kmLng, 20]);
  const today = g.ss.getSheetByName('오늘배송');
  const H = today.data[0];
  const r = today.getLastRow() + 1;
  today.set(r, 1, '2026-11-16'); today.set(r, 2, '예시-귀사길매입'); today.set(r, 3, 5000); today.set(r, 4, 8500);
  today.set(r, H.indexOf('구분') + 1, '매입');

  vctx.menuAddPickupsLive();
  assert.match(alerts.at(-1), /V10 1회차 예시-원거리공장 다음에 추가/, alerts.at(-1));
  assert.match(alerts.at(-1), /기존 링크 그대로/);

  const logs = table(vctx, '운행일지').filter((x) => x['차량ID'] === 'V10');
  assert.deepStrictEqual(logs.map((x) => x['거래처명']), ['예시-원거리공장', '예시-귀사길매입', '회사 복귀']);
  assert.strictEqual(logs[1]['구분'], '매입');
  assert.strictEqual(logs[2]['출발시각'], '', '복귀 출발 기록은 지우고 매입처부터 다시');

  // 같은 링크로 이어서: 현재 차례는 매입처, 버튼은 상차 완료
  let st = vctx.getTripState(p);
  assert.strictEqual(st.current, 1);
  assert.strictEqual(st.stops[1].isPickup, true);
  vctx.tapStop(p, 1, 'start');
  vctx.tapStop(p, 1, 'complete');
  st = vctx.tapStop(p, 2, 'start');
  st = vctx.tapStop(p, 2, 'complete');
  assert.strictEqual(st.tripDone, true);

  const added = table(vctx, '오늘배송').find((x) => x['거래처명'] === '예시-귀사길매입');
  assert.strictEqual(added['배정차량ID'], 'V10');
  assert.strictEqual(added['방문순서'], 2);
  const trip = table(vctx, '회차').find((x) => x['차량ID'] === 'V10');
  assert.strictEqual(trip['방문수'], 2);
  assert.match(trip['경유지2'], /^\[매입\] 예시-귀사길매입 ✓/);
});

test('운행 중 매입 추가: 넣을 회차가 없으면 매입 전용 새 회차와 새 링크', () => {
  const { g, vctx, alerts } = setup();
  vctx.menuSample();
  vctx.menuPlan();
  // 1톤만 실을 수 있는 짧은 매입을, 모든 회차가 끝난 상황에서 추가
  vctx.ensureOptionalColumns_();
  table(vctx, '회차').forEach((t) => vctx.updateRow_(g.ss.getSheetByName('회차'), t._row, { '상태': '완료' }));
  g.ss.getSheetByName('거래처').appendRow(['예시-늦은매입', '(예시)', 36.52, 127.52, 20]);
  const today = g.ss.getSheetByName('오늘배송');
  const H = today.data[0];
  const r = today.getLastRow() + 1;
  today.set(r, 1, '2026-11-16'); today.set(r, 2, '예시-늦은매입'); today.set(r, 3, 300); today.set(r, 4, 1500);
  today.set(r, H.indexOf('구분') + 1, '매입');
  vctx.menuAddPickupsLive();
  assert.match(alerts.at(-1), /매입 전용, 새 회차/);
  assert.match(alerts.at(-1), /새 링크/);
  const added = table(vctx, '오늘배송').find((x) => x['거래처명'] === '예시-늦은매입');
  const t = table(vctx, '회차').find((x) => x['차량ID'] === added['배정차량ID'] && x['회차'] === added['회차']);
  assert.match(t['링크'], /exec\?d=2026-11-16/);
  const logs = table(vctx, '운행일지').filter((x) => x['차량ID'] === added['배정차량ID'] && x['회차'] === added['회차']);
  assert.deepStrictEqual(logs.map((x) => x['거래처명']), ['예시-늦은매입', '회사 복귀']);
});

test('운행 중 매입 추가: 추가할 행이 없으면 무엇을 보았는지 알려 준다', () => {
  const { g, vctx, alerts } = setup();
  vctx.menuSample();
  vctx.menuPlan();
  const today = g.ss.getSheetByName('오늘배송');
  const H = today.data[0];
  const r = today.getLastRow() + 1;
  today.set(r, 1, '2026-11-15'); today.set(r, 2, '예시-근거리A'); today.set(r, 3, 100); today.set(r, 4, 100);
  today.set(r, H.indexOf('구분') + 1, '매입');
  vctx.menuAddPickupsLive();
  assert.match(alerts.at(-1), /추가할 매입 행이 없습니다/);
  assert.match(alerts.at(-1), /일자가 오늘이 아닌 매입 행: \d+행\(2026-11-15\)/);
});

test('설정 탭 작업일자가 있으면 그 날짜를 다룬다(자정 이후 전날 운행 처리)', () => {
  const { g, vctx, alerts } = setup();
  vctx.menuSample();
  vctx.menuPlan(); // 11-16 배차
  g.clock.now = new Date('2026-11-17T00:20:00+09:00'); // 자정 지남
  const today = g.ss.getSheetByName('오늘배송');
  const H = today.data[0];
  const r = today.getLastRow() + 1;
  today.set(r, 1, '2026-11-16'); today.set(r, 2, '예시-근거리A'); today.set(r, 3, 100); today.set(r, 4, 100);
  today.set(r, H.indexOf('구분') + 1, '매입');
  vctx.menuAddPickupsLive();
  assert.match(alerts.at(-1), /일자가 오늘이 아닌 매입 행/);
  g.ss.getSheetByName('설정').appendRow(['작업일자', new g.ctx.Date('2026-11-16T00:00:00+09:00'), '']); // 시트 날짜 값
  vm.runInContext('sheetConfigMemo_ = null', vctx);
  vctx.menuAddPickupsLive();
  assert.match(alerts.at(-1), /예시-근거리A: V\d+ \d회차/);
});
