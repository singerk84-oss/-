/**
 * links.gs — 회차별 웹앱 링크 생성과 서명 토큰
 *
 * 링크 파라미터: d(일자), v(차량ID), t(회차), s(서명 토큰)
 * 토큰 = HMAC-SHA256(LINK_SECRET, "일자|차량ID|회차")를 base64url로 바꾼 앞 22자
 * 서버(webapp.gs)는 모든 요청에서 토큰을 다시 계산해 검증한다.
 */

function linkSecret_() {
  var s = getProp_('LINK_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    setProp_('LINK_SECRET', s);
  }
  return s;
}

function signTrip_(date, vehicleId, trip) {
  var msg = date + '|' + vehicleId + '|' + trip;
  var raw = Utilities.computeHmacSha256Signature(msg, linkSecret_(), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '').slice(0, 22);
}

/** 길이와 무관하게 일정한 비교(타이밍 공격 완화) */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifyTrip_(date, vehicleId, trip, token) {
  if (!date || !vehicleId || !trip || !token) return false;
  return safeEqual_(signTrip_(date, vehicleId, String(trip)), token);
}

function webAppUrl_() {
  var url = getProp_('WEBAPP_URL') || ScriptApp.getService().getUrl();
  if (!url) throw new Error('웹앱이 배포되지 않았습니다. [배포 > 새 배포 > 웹 앱] 후 다시 실행하세요.');
  return url;
}

function buildTripLink_(date, vehicleId, trip) {
  return webAppUrl_() +
    '?d=' + encodeURIComponent(date) +
    '&v=' + encodeURIComponent(vehicleId) +
    '&t=' + encodeURIComponent(trip) +
    '&s=' + signTrip_(date, vehicleId, String(trip));
}

/**
 * TMAP 앱 길안내 링크. 기사 휴대폰의 TMAP 앱에서 [설정 > 차량 정보]를 화물차로 등록해 두면
 * 실제 주행 안내도 높이·중량 제한을 피한다.
 * ※ URL 스킴 파라미터(goalname/goalx/goaly)는 TMAP 공식 문서와 대조가 필요하다.
 */
function tmapLink_(name, lat, lng) {
  return 'tmap://route?goalname=' + encodeURIComponent(name) + '&goalx=' + lng + '&goaly=' + lat;
}

/** 기사 화면 길안내: TMAP 앱만 사용 */
function navLinks_(name, lat, lng) {
  return { main: tmapLink_(name, lat, lng), mainLabel: 'TMAP' };
}

/** 회차 시트의 모든 회차(해당 일자)에 링크를 채운다 */
function generateLinks(date) {
  date = date || todayKey_();
  var sh = getSheet_(SHEET.TRIPS, HEADERS.TRIPS);
  var count = 0;
  readTable_(SHEET.TRIPS, HEADERS.TRIPS).forEach(function (r) {
    if (dateKey_(r['일자']) !== date) return;
    updateRow_(sh, r._row, { '링크': buildTripLink_(date, String(r['차량ID']), String(r['회차'])) });
    count++;
  });
  return count;
}
