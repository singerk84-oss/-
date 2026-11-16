/**
 * notify.gs — 회차별 링크 전송
 *
 * NOTIFY_MODE(스크립트 속성)
 *   email      : 담당자 이메일로 회차 링크 목록 전송(기본, 별도 준비 불필요)
 *   kakao_memo : 1단계 — 카카오톡 '나에게 보내기'로 담당자에게 전송 후 기사에게 전달
 *   alimtalk   : 2단계 — 알림톡으로 기사 휴대폰에 직접 전송(대행사 결정 후 구현)
 */

var KAKAO_AUTH = 'https://kauth.kakao.com/oauth';
var KAKAO_MEMO = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';

/** 해당 일자의 회차 링크를 전송한다 */
function sendTripLinks(date) {
  var mode = getProp_('NOTIFY_MODE') || 'email';
  var sh = getSheet_(SHEET.TRIPS, HEADERS.TRIPS);
  var vehicles = {};
  readTable_(SHEET.VEHICLES).forEach(function (v) { vehicles[String(v['차량ID'])] = v; });

  var stopsByTrip = {};
  readTable_(SHEET.TODAY).forEach(function (r) {
    if (dateKey_(r['일자']) !== date || r['배정차량ID'] === '') return;
    var k = r['배정차량ID'] + '#' + r['회차'];
    (stopsByTrip[k] = stopsByTrip[k] || []).push({ seq: Number(r['방문순서']), name: r['거래처명'] });
  });

  var trips = readTable_(SHEET.TRIPS).filter(function (r) { return dateKey_(r['일자']) === date && r['링크']; });
  if (!trips.length) throw new Error('전송할 회차 링크가 없습니다. 먼저 배차·경로 계산을 실행하세요.');

  var messages = trips.map(function (t) {
    var v = vehicles[String(t['차량ID'])] || {};
    var stops = (stopsByTrip[t['차량ID'] + '#' + t['회차']] || [])
      .sort(function (a, b) { return a.seq - b.seq; })
      .map(function (x) { return x.name; });
    var text = '[배송 ' + date.slice(5) + '] ' + (v['차량명'] || t['차량ID']) + ' ' + t['회차'] + '회차' +
      (v['기사명'] ? ' · ' + v['기사명'] : '') + '\n' +
      '출발 ' + t['출발예정'] + ' / 복귀 ' + t['복귀예정'] + '\n' + stops.join(' → ');
    return { row: t._row, text: text, link: t['링크'], phone: v['기사휴대폰'] };
  });

  if (mode === 'kakao_memo') {
    var token = kakaoAccessToken_();
    messages.forEach(function (m) { sendKakaoMemo_(token, m.text, m.link); });
  } else if (mode === 'alimtalk') {
    messages.forEach(function (m) { sendAlimtalk_(m.phone, m.text, m.link); });
  } else {
    var to = getProp_('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
    var body = messages.map(function (m) { return m.text + '\n' + m.link; }).join('\n\n');
    MailApp.sendEmail(to, '[배송] ' + date + ' 회차 링크 ' + messages.length + '건', body);
  }

  var stamp = nowStamp_();
  messages.forEach(function (m) { updateRow_(sh, m.row, { '전송시각': stamp }); });
  return { sent: messages.length, mode: mode };
}

/* ---------------- 카카오 '나에게 보내기' ---------------- */

/** 카카오 로그인 인가 URL(최초 1회, 리프레시 토큰 발급용) */
function kakaoAuthorizeUrl_() {
  return KAKAO_AUTH + '/authorize?response_type=code&scope=talk_message' +
    '&client_id=' + encodeURIComponent(kakaoKey_()) +
    '&redirect_uri=' + encodeURIComponent(webAppUrl_()) +
    '&state=' + encodeURIComponent(kakaoOAuthState_());
}

function kakaoOAuthState_() {
  return signTrip_('kakao-oauth', 'login', '0');
}

/** 웹앱이 인가 코드를 받으면 토큰으로 교환해 리프레시 토큰을 저장한다 */
function handleKakaoOAuth_(code, state) {
  if (!safeEqual_(state, kakaoOAuthState_())) throw new Error('잘못된 로그인 요청입니다.');
  var payload = {
    grant_type: 'authorization_code',
    client_id: kakaoKey_(),
    redirect_uri: webAppUrl_(),
    code: code
  };
  var secret = getProp_('KAKAO_CLIENT_SECRET');
  if (secret) payload.client_secret = secret;
  var r = fetchJsonWithRetry_(KAKAO_AUTH + '/token', { method: 'post', payload: payload }, '카카오토큰');
  if (!r.refresh_token) throw new Error('리프레시 토큰을 받지 못했습니다.');
  setProp_('KAKAO_REFRESH_TOKEN', r.refresh_token);
}

/** 리프레시 토큰으로 액세스 토큰 발급(리프레시 토큰이 갱신되면 함께 저장) */
function kakaoAccessToken_() {
  var refresh = getProp_('KAKAO_REFRESH_TOKEN');
  if (!refresh) throw new Error('카카오 로그인이 필요합니다. [배송관리 > 카카오 로그인]을 먼저 실행하세요.');
  var payload = { grant_type: 'refresh_token', client_id: kakaoKey_(), refresh_token: refresh };
  var secret = getProp_('KAKAO_CLIENT_SECRET');
  if (secret) payload.client_secret = secret;
  var r = fetchJsonWithRetry_(KAKAO_AUTH + '/token', { method: 'post', payload: payload }, '카카오토큰');
  if (r.refresh_token) setProp_('KAKAO_REFRESH_TOKEN', r.refresh_token);
  return r.access_token;
}

function sendKakaoMemo_(accessToken, text, link) {
  var template = {
    object_type: 'text',
    text: text.slice(0, 200),
    link: { web_url: link, mobile_web_url: link },
    button_title: '회차 열기'
  };
  var r = fetchJsonWithRetry_(KAKAO_MEMO, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: { template_object: JSON.stringify(template) }
  }, '나에게보내기');
  if (r.result_code !== 0) throw new Error('나에게 보내기 실패: ' + JSON.stringify(r));
}

/* ---------------- 2단계: 알림톡 ---------------- */

/**
 * 알림톡 발송 자리. 대행사 결정 후 해당 API 규격에 맞춰 구현한다.
 * 필요: 카카오 비즈니스 채널, 승인된 메시지 양식(템플릿 코드), 대행사 API 키(스크립트 속성).
 */
function sendAlimtalk_(phone, text, link) {
  throw new Error('알림톡은 2단계 기능입니다(발송 대행사 결정 후 구현). NOTIFY_MODE를 email 또는 kakao_memo로 설정하세요.');
}
