// 통합 시험: 시트 템플릿 → 예시 데이터 → 배차·경로 → 링크 → 웹앱 완료 처리 → 일일마감
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gas-mock');

const FILES = ['config.gs', 'util.gs', 'sheets.gs', 'geocode.gs', 'matrix.gs', 'route.gs', 'assign.gs',
  'links.gs', 'notify.gs', 'log.gs', 'webapp.gs', 'main.gs'];

function setup() {
  const g = createGas({ props: { DISTANCE_MODE: 'estimate' } });
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
  assert.match(st.stops[0].nav, /^https:\/\/map\.kakao\.com\/link\/to\//);

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
