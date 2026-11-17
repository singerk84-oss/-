/**
 * webapp.gs — 기사용 웹앱(doGet), 완료 처리, 마감 처리
 *
 * 모든 서버 함수는 링크의 서명 토큰을 다시 검증한다.
 * 동시에 두 번 누르는 경우를 막기 위해 기록은 스크립트 잠금 안에서 한다.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};

  // 카카오 로그인 리다이렉트(나에게 보내기 권한 저장)
  if (p.code && p.state) {
    try {
      handleKakaoOAuth_(p.code, p.state);
      return simplePage_('카카오 로그인 완료', '나에게 보내기 권한을 저장했습니다. 이 창을 닫아도 됩니다.');
    } catch (err) {
      return simplePage_('카카오 로그인 실패', err.message);
    }
  }

  if (!verifyTrip_(p.d, p.v, p.t, p.s)) {
    return simplePage_('잘못된 링크', '링크가 올바르지 않거나 만료되었습니다. 담당자에게 문의하세요.');
  }
  var tpl = HtmlService.createTemplateFromFile('index');
  // 스크립트 태그 안에 넣으므로 '<'를 이스케이프한다
  tpl.params = JSON.stringify({ d: p.d, v: p.v, t: p.t, s: p.s }).replace(/</g, '\\u003c');
  return tpl.evaluate()
    .setTitle(p.v + ' ' + p.t + '회차 배송')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

function simplePage_(title, message) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;padding:24px"><h2>' + escapeHtml_(title) + '</h2><p>' +
    escapeHtml_(message) + '</p></div>'
  ).setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function assertParams_(p) {
  if (!p || !verifyTrip_(p.d, p.v, p.t, p.s)) throw new Error('잘못된 링크입니다.');
}

/** 시각 셀 → 'HH:mm' */
function timeText_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(v);
}

/** 웹앱 화면 상태 */
function getTripState(p) {
  assertParams_(p);
  var rows = tripLogRows_(p.d, p.v, p.t);
  if (!rows.length) throw new Error('회차 정보가 없습니다. 배차가 다시 계산되었을 수 있으니 담당자에게 문의하세요.');

  var s = readSettings_();
  var customers = {};
  readTable_(SHEET.CUSTOMERS).forEach(function (c) { customers[String(c['거래처명']).trim()] = c; });
  var eta = {};
  readTable_(SHEET.TODAY).forEach(function (r) {
    if (dateKey_(r['일자']) === p.d && String(r['배정차량ID']) === p.v && String(r['회차']) === String(p.t)) {
      eta[String(r['거래처명']).trim()] = timeText_(r['예상도착시각']);
    }
  });
  var vehicle = readTable_(SHEET.VEHICLES).filter(function (v) { return String(v['차량ID']) === p.v; })[0] || {};

  var current = -1;
  var stops = rows.map(function (r, i) {
    var name = String(r['거래처명']).trim();
    var isReturn = name === RETURN_LABEL;
    var c = customers[name] || {};
    var lat = isReturn ? s.companyLat : c['위도'];
    var lng = isReturn ? s.companyLng : c['경도'];
    var done = r['완료시각'] !== '';
    if (!done && current < 0) current = i;
    return {
      index: i,
      name: name,
      isReturn: isReturn,
      address: isReturn ? s.companyAddress : (c['주소'] || ''),
      eta: eta[name] || '',
      depart: timeText_(r['출발시각']),
      arrive: timeText_(r['도착시각']),
      complete: timeText_(r['완료시각']),
      distKm: r['구간거리(API,km)'],
      nav: lat !== '' && lat !== null && lat !== undefined ? navLinks_(isReturn ? '회사' : name, lat, lng) : null
    };
  });

  var lastTrip = isLastTripOfDay_(p.d, p.v, p.t);
  var close = findClose_(p.d, p.v);
  return {
    date: p.d,
    vehicleId: p.v,
    trip: Number(p.t),
    vehicleName: vehicle['차량명'] || p.v,
    plate: vehicle['차량번호'] || '',
    driver: vehicle['기사명'] || '',
    stops: stops,
    current: current,
    tripDone: current < 0,
    isLastTrip: lastTrip,
    closed: close ? {
      odometer: close['계기판주행거리(km)'], real: close['전일대비실주행(km)'],
      api: close['API합산거리(km)'], diff: close['차이(km)']
    } : null
  };
}

function isLastTripOfDay_(date, vehicleId, trip) {
  var max = 0;
  readTable_(SHEET.TRIPS, HEADERS.TRIPS).forEach(function (r) {
    if (dateKey_(r['일자']) === date && String(r['차량ID']) === String(vehicleId)) {
      max = Math.max(max, Number(r['회차']));
    }
  });
  return Number(trip) === max;
}

function setTripStatus_(date, vehicleId, trip, status) {
  var sh = getSheet_(SHEET.TRIPS, HEADERS.TRIPS);
  readTable_(SHEET.TRIPS, HEADERS.TRIPS).forEach(function (r) {
    if (dateKey_(r['일자']) === date && String(r['차량ID']) === String(vehicleId) && String(r['회차']) === String(trip)) {
      updateRow_(sh, r._row, { '상태': status });
    }
  });
}

/**
 * 버튼 처리
 * @param {Object} p 링크 파라미터
 * @param {number} index 회차 안 순번(0부터, 마지막은 회사 복귀)
 * @param {string} action 'start'(업체명 탭) | 'arrive'(도착) | 'complete'(완료)
 */
function tapStop(p, index, action) {
  assertParams_(p);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = tripLogRows_(p.d, p.v, p.t);
    var current = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i]['완료시각'] === '') { current = i; break; }
    }
    if (current < 0) throw new Error('이미 모든 배송이 완료된 회차입니다.');
    if (Number(index) !== current) throw new Error('지금은 ' + rows[current]['거래처명'] + ' 차례입니다.');

    var row = rows[current];
    var sh = getSheet_(SHEET.LOG);
    var now = nowTime_();
    if (action === 'start') {
      if (row['출발시각'] === '') updateRow_(sh, row._row, { '출발시각': now });
      if (current === 0) setTripStatus_(p.d, p.v, p.t, '운행중');
    } else if (action === 'arrive') {
      if (row['출발시각'] === '') throw new Error('먼저 업체명을 눌러 출발을 기록하세요.');
      if (row['도착시각'] === '') updateRow_(sh, row._row, { '도착시각': now });
    } else if (action === 'complete') {
      if (row['출발시각'] === '') throw new Error('먼저 업체명을 눌러 출발을 기록하세요.');
      var patch = { '완료시각': now };
      if (row['도착시각'] === '') patch['도착시각'] = now;
      updateRow_(sh, row._row, patch);
      if (current === rows.length - 1) setTripStatus_(p.d, p.v, p.t, '완료');
    } else {
      throw new Error('알 수 없는 동작입니다.');
    }
  } finally {
    lock.releaseLock();
  }
  return getTripState(p);
}

/** 오늘 마감: 그날 마지막 회차 완료 후 계기판 주행거리 1회 입력 */
function submitClose(p, odometerKm) {
  assertParams_(p);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!isLastTripOfDay_(p.d, p.v, p.t)) throw new Error('오늘 마지막 회차에서만 마감할 수 있습니다.');
    var rows = tripLogRows_(p.d, p.v, p.t);
    if (rows.some(function (r) { return r['완료시각'] === ''; })) throw new Error('회사 복귀까지 완료한 뒤 마감하세요.');
    closeDay_(p.d, p.v, odometerKm);
  } finally {
    lock.releaseLock();
  }
  return getTripState(p);
}
