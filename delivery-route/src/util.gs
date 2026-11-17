/**
 * util.gs — 시간·거리 계산 공통 함수(외부 서비스에 의존하지 않는 순수 함수)
 * Node 테스트(test/)에서도 그대로 불러 쓴다.
 */

/** 'HH:MM' 또는 Date 또는 하루 비율(시트 시각 값) → 자정 기준 분 */
function toMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    // 시트의 시각 셀이 숫자(하루 비율)로 들어오는 경우
    return value < 1.5 ? Math.round(value * 24 * 60) : Math.round(value);
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return value.getHours() * 60 + value.getMinutes();
  }
  var m = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) throw new Error('시각 형식이 올바르지 않습니다: ' + value);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 자정 기준 분 → 'HH:MM' (24시를 넘으면 그대로 표기, 예: 25:10) */
function formatMinutes(min) {
  if (min === null || min === undefined || isNaN(min)) return '';
  var total = Math.round(min);
  var h = Math.floor(total / 60);
  var m = total % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

/**
 * 시트에 쓸 시각 값. 앞에 '를 붙여 글자로 저장한다.
 * (시트가 시각 값으로 바꾸면 Apps Script에서 1899년 기준 날짜로 읽혀 몇 분씩 어긋날 수 있다)
 */
function timeCell(text) {
  return text === '' || text === null || text === undefined ? '' : "'" + text;
}

/** 두 좌표 사이 직선거리(km) — 하버사인 공식 */
function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 좌표를 캐시 키용 문자열로(소수 6자리, 약 0.1m 정밀도) */
function coordKey(lat, lng) {
  return Number(lat).toFixed(6) + ',' + Number(lng).toFixed(6);
}

/** 빈 값/문자 숫자를 숫자로. 변환 불가면 fallback */
function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  var n = Number(String(value).replace(/,/g, ''));
  return isNaN(n) ? fallback : n;
}

/** 체크박스·문자 입력을 불리언으로 */
function toBool(value) {
  if (value === true) return true;
  var s = String(value).trim().toUpperCase();
  return s === 'TRUE' || s === 'Y' || s === 'O' || s === '1' || s === '예' || s === 'V';
}
