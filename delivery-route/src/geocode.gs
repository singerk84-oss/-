/**
 * geocode.gs — 주소 → 좌표 변환(카카오 로컬 API)과 캐시
 *
 * 좌표는 거래처 시트 위도·경도 칸에 저장되므로 시트 자체가 영구 캐시다.
 * 위도·경도가 비어 있는 행만 API를 호출한다. 주소를 바꾸면 위도·경도를 지우고 다시 실행한다.
 */

var KAKAO_LOCAL_ADDRESS = 'https://dapi.kakao.com/v2/local/search/address.json';
var KAKAO_LOCAL_KEYWORD = 'https://dapi.kakao.com/v2/local/search/keyword.json';

function kakaoKey_() {
  var key = getProp_('KAKAO_REST_KEY');
  if (!key) throw new Error('스크립트 속성 KAKAO_REST_KEY가 없습니다. 카카오 REST API 키를 등록하세요.');
  return key;
}

/**
 * 재시도가 포함된 HTTP 호출. 실패 시 오류로그에 남기고 예외를 던진다.
 * 4xx(요청 오류)는 재시도해도 같으므로 바로 실패 처리한다(429 제외).
 */
function fetchJsonWithRetry_(url, options, kind) {
  options = options || {};
  options.muteHttpExceptions = true;
  var lastErr = '';
  for (var attempt = 1; attempt <= API_RETRY; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, options);
      var code = res.getResponseCode();
      var body = res.getContentText();
      if (code >= 200 && code < 300) return JSON.parse(body);
      lastErr = 'HTTP ' + code + ' ' + body.slice(0, 300);
      if (code >= 400 && code < 500 && code !== 429) break;
    } catch (e) {
      lastErr = String(e);
    }
    if (attempt < API_RETRY) Utilities.sleep(API_RETRY_WAIT_MS * attempt);
  }
  logError_(kind, url.split('?')[0] + ' 실패: ' + lastErr);
  throw new Error(kind + ' 실패: ' + lastErr);
}

function kakaoGet_(url, kind) {
  return fetchJsonWithRetry_(url, {
    method: 'get',
    headers: { Authorization: 'KakaoAK ' + kakaoKey_() }
  }, kind);
}

/** 주소 1건 → {lat, lng} 또는 null. 주소 검색 실패 시 키워드 검색으로 한 번 더 찾는다. */
function geocodeAddress(address) {
  var q = encodeURIComponent(address);
  var r = kakaoGet_(KAKAO_LOCAL_ADDRESS + '?query=' + q, '주소검색');
  var doc = r.documents && r.documents[0];
  if (!doc) {
    r = kakaoGet_(KAKAO_LOCAL_KEYWORD + '?query=' + q, '키워드검색');
    doc = r.documents && r.documents[0];
  }
  if (!doc) return null;
  return { lat: Number(doc.y), lng: Number(doc.x) };
}

/** 회사와 거래처 중 좌표가 비어 있는 곳을 채운다. 반환: 처리 결과 요약 */
function geocodeAll() {
  var done = 0;
  var failed = [];

  var s = readSettings_();
  if (s.companyAddress && (s.companyLat === null || s.companyLng === null)) {
    var c = safeGeocode_(s.companyAddress);
    if (c) {
      writeSetting_('회사위도', c.lat);
      writeSetting_('회사경도', c.lng);
      done++;
    } else {
      failed.push('회사(' + s.companyAddress + ')');
    }
  }

  var sh = getSheet_(SHEET.CUSTOMERS);
  readTable_(SHEET.CUSTOMERS).forEach(function (row) {
    var addr = String(row['주소'] || '').trim();
    if (!addr) return;
    if (row['위도'] !== '' && row['경도'] !== '') return;
    var g = safeGeocode_(addr);
    if (g) {
      var patch = { '위도': g.lat, '경도': g.lng };
      if (row['체류시간(분)'] === '') patch['체류시간(분)'] = s.defaultStayMin;
      updateRow_(sh, row._row, patch);
      done++;
    } else {
      failed.push(row['거래처명'] + '(' + addr + ')');
    }
  });
  return { done: done, failed: failed };
}

function safeGeocode_(addr) {
  try {
    var g = geocodeAddress(addr);
    if (!g) logError_('주소검색', '결과 없음: ' + addr);
    return g;
  } catch (e) {
    return null;
  }
}
