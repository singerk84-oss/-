/**
 * log.gs — 운행일지 기록과 일일마감
 *
 * 배차 계산 시 회차마다 [배송지 순서대로 1행씩 + '회사 복귀' 1행]을 운행일지에 미리 만든다.
 * 구간거리(API,km)는 직전 지점 → 해당 지점의 API 거리다. 웹앱 버튼이 시각 칸을 채운다.
 */

/** 해당 일자에 출발시각이 하나라도 기록됐는지 */
function hasStartedLogs_(date) {
  return readTable_(SHEET.LOG).some(function (r) {
    return dateKey_(r['일자']) === date && r['출발시각'] !== '';
  });
}

/** 해당 일자의 운행일지·회차 행 삭제(재계산 전) */
function clearDayRows_(name, date) {
  var sh = getSheet_(name);
  var rows = readTable_(name).filter(function (r) { return dateKey_(r['일자']) === date; });
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { sh.deleteRow(r._row); });
}

/**
 * 회차별 운행일지 행 생성
 * @param {Object[]} legsByTrip [{vehicleId, trip, legs:[{name, distKm}], returnDistKm}]
 */
function createLogRows_(date, legsByTrip) {
  var sh = getSheet_(SHEET.LOG);
  var out = [];
  legsByTrip.forEach(function (t) {
    t.legs.forEach(function (leg) {
      out.push([date, t.vehicleId, t.trip, leg.name, '', '', '', round1_(leg.distKm)]);
    });
    out.push([date, t.vehicleId, t.trip, RETURN_LABEL, '', '', '', round1_(t.returnDistKm)]);
  });
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
}

function round1_(x) {
  return Math.round(x * 10) / 10;
}

/** 회차의 운행일지 행들(시트 순서 = 방문 순서) */
function tripLogRows_(date, vehicleId, trip) {
  return readTable_(SHEET.LOG).filter(function (r) {
    return dateKey_(r['일자']) === date && String(r['차량ID']) === String(vehicleId) &&
      String(r['회차']) === String(trip);
  }).sort(function (a, b) { return a._row - b._row; });
}

/** 차량의 하루 API 합산 거리 — 실제 운행(출발 기록)된 구간만 더한다 */
function apiDistanceOfDay_(date, vehicleId) {
  return round1_(readTable_(SHEET.LOG).reduce(function (sum, r) {
    if (dateKey_(r['일자']) !== date || String(r['차량ID']) !== String(vehicleId)) return sum;
    if (r['출발시각'] === '') return sum;
    return sum + toNumber(r['구간거리(API,km)'], 0);
  }, 0));
}

/** 일일마감 기록 조회 */
function findClose_(date, vehicleId) {
  var rows = readTable_(SHEET.CLOSE).filter(function (r) {
    return dateKey_(r['일자']) === date && String(r['차량ID']) === String(vehicleId);
  });
  return rows.length ? rows[0] : null;
}

/** 해당 일자 이전의 가장 최근 계기판 값 */
function previousOdometer_(date, vehicleId) {
  var prev = null;
  var prevDate = '';
  readTable_(SHEET.CLOSE).forEach(function (r) {
    var d = dateKey_(r['일자']);
    if (String(r['차량ID']) !== String(vehicleId) || d >= date) return;
    var v = toNumber(r['계기판주행거리(km)'], null);
    if (v === null) return;
    if (d > prevDate) { prevDate = d; prev = v; }
  });
  return prev;
}

/**
 * 일일마감 기록(차량별 하루 1회). 전일 계기판 값이 없으면 실주행·차이는 비워 둔다.
 * @return {Object} 기록한 값
 */
function closeDay_(date, vehicleId, odometerKm) {
  var odo = toNumber(odometerKm, null);
  if (odo === null || odo < 0) throw new Error('계기판 주행거리를 숫자로 입력하세요.');
  if (findClose_(date, vehicleId)) throw new Error('이미 오늘 마감이 입력되었습니다.');
  var prev = previousOdometer_(date, vehicleId);
  if (prev !== null && odo < prev) throw new Error('전일 계기판 값(' + prev + 'km)보다 작습니다. 다시 확인하세요.');
  var real = prev === null ? '' : round1_(odo - prev);
  var api = apiDistanceOfDay_(date, vehicleId);
  var diff = real === '' ? '' : round1_(real - api);
  appendRow_(getSheet_(SHEET.CLOSE), {
    '일자': date, '차량ID': vehicleId, '계기판주행거리(km)': odo,
    '전일대비실주행(km)': real, 'API합산거리(km)': api, '차이(km)': diff
  });
  return { odometer: odo, real: real, api: api, diff: diff, prev: prev };
}
