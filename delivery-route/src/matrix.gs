/**
 * matrix.gs — 구간 거리·시간 행렬
 *
 * 경로 제공자(ROUTE_PROVIDER)
 *   tmap     : TMAP 화물차 경로안내 — 차량 높이·폭·길이·중량 제한을 반영(기본)
 *   kakao    : 카카오모빌리티 자동차 길찾기 — 승용차 기준(화물차 제한 미반영)
 *   estimate : API 없이 직선거리×우회계수, 평균속도로 추정(시험용)
 *
 * 화물차는 차량마다 지날 수 있는 길이 다르므로 행렬을 차량 프로필별로 만든다.
 * 같은 날 같은 프로필·같은 좌표쌍은 '구간캐시' 시트에서 재사용한다.
 */

var KAKAO_DIRECTIONS = 'https://apis-navi.kakaomobility.com/v1/directions';

/**
 * TMAP 화물차 경로안내 규격.
 * ※ 공식 문서(SK오픈API TMAP > 화물차 경로안내)와 대조가 필요하다. 다르면 이 블록만 고친다.
 */
var TMAP_TRUCK = {
  url: 'https://apis.openapi.sk.com/tmap/truck/routes?version=1&format=json',
  keyHeader: 'appKey',
  /** 요청 본문 생성: 좌표는 경도(X)·위도(Y), WGS84 */
  body: function (from, to, p) {
    var b = {
      startX: String(from.lng), startY: String(from.lat),
      endX: String(to.lng), endY: String(to.lat),
      reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO',
      searchOption: '0',      // 0: 추천 경로
      totalValue: '2'         // 2: 요약(총거리·총시간)만 받는다
    };
    if (p.truckType) b.truckType = String(p.truckType);
    if (p.heightCm) b.truckHeight = String(p.heightCm);
    if (p.widthCm) b.truckWidth = String(p.widthCm);
    if (p.lengthCm) b.truckLength = String(p.lengthCm);
    if (p.cargoKg) b.truckWeight = String(p.cargoKg);
    if (p.totalKg) b.truckTotalWeight = String(p.totalKg);
    return b;
  },
  /** 응답 → {distanceM, durationS} */
  parse: function (r) {
    var f = r && r.features && r.features[0];
    var prop = f && f.properties;
    if (!prop || prop.totalDistance === undefined) return null;
    return { distanceM: Number(prop.totalDistance), durationS: Number(prop.totalTime) };
  }
};

/**
 * 차량 시트 한 행 → 경로 프로필
 * 화물중량은 회차마다 달라지므로 보수적으로 최대적재중량을 넣는다(중량 제한 구간 회피 목적).
 */
function vehicleProfile_(v) {
  var p = {
    truckType: String(v['TMAP차종'] === undefined ? '' : v['TMAP차종']).trim(),
    heightCm: toNumber(v['차량높이(cm)'], 0),
    widthCm: toNumber(v['차량폭(cm)'], 0),
    lengthCm: toNumber(v['차량길이(cm)'], 0),
    cargoKg: toNumber(v['최대적재중량(kg)'], 0),
    totalKg: toNumber(v['차량총중량(kg)'], 0)
  };
  p.key = profileKey_(p);
  return p;
}

function profileKey_(p) {
  var provider = routeProvider_();
  if (provider !== 'tmap') return provider;
  return ['T' + p.truckType, 'H' + p.heightCm, 'W' + p.widthCm, 'L' + p.lengthCm,
    'C' + p.cargoKg, 'G' + p.totalKg].join('|');
}

/** 화물차 경로에 필요한 값이 비었는지 점검 → 경고 문구 목록 */
function profileWarnings_(vehicleId, p) {
  if (routeProvider_() !== 'tmap') return [];
  var miss = [];
  if (!p.truckType) miss.push('TMAP차종');
  if (!p.heightCm) miss.push('차량높이(cm)');
  if (!p.totalKg) miss.push('차량총중량(kg)');
  return miss.length ? [vehicleId + ': 화물차 제한 반영에 필요한 값 없음(' + miss.join(', ') + ')'] : [];
}

/** 한 번의 실행 안에서 쓰는 메모리 캐시 */
var legMemo_ = null;

function loadLegCache_(date) {
  if (legMemo_ && legMemo_.date === date) return legMemo_;
  var map = {};
  readTable_(SHEET.LEG_CACHE, HEADERS.LEG_CACHE).forEach(function (r) {
    if (dateKey_(r['일자']) !== date) return;
    map[(r['차량프로필'] || '') + '@' + r['출발좌표'] + '>' + r['도착좌표']] = {
      distanceM: Number(r['거리(m)']), durationS: Number(r['시간(초)']), source: r['출처']
    };
  });
  legMemo_ = { date: date, map: map, pending: [] };
  return legMemo_;
}

function flushLegCache_() {
  if (!legMemo_ || !legMemo_.pending.length) return;
  var sh = getSheet_(SHEET.LEG_CACHE, HEADERS.LEG_CACHE);
  sh.getRange(sh.getLastRow() + 1, 1, legMemo_.pending.length, HEADERS.LEG_CACHE.length)
    .setValues(legMemo_.pending);
  legMemo_.pending = [];
}

/**
 * 구간 1개의 거리·시간. from/to = {lat, lng}, profile = vehicleProfile_ 결과
 * @return {{distanceM:number, durationS:number, source:string}}
 */
function getLeg_(date, from, to, profile) {
  var a = coordKey(from.lat, from.lng);
  var b = coordKey(to.lat, to.lng);
  if (a === b) return { distanceM: 0, durationS: 0, source: 'same' };
  var provider = routeProvider_();
  var pkey = profile ? profile.key : provider;
  var cache = loadLegCache_(date);
  var key = pkey + '@' + a + '>' + b;
  if (cache.map[key]) return cache.map[key];

  var leg;
  if (provider === 'estimate') {
    var km = haversineKm(from.lat, from.lng, to.lat, to.lng) * ESTIMATE_ROAD_FACTOR;
    leg = { distanceM: Math.round(km * 1000), durationS: Math.round(km / ESTIMATE_SPEED_KMH * 3600), source: 'estimate' };
  } else if (provider === 'kakao') {
    leg = kakaoLeg_(from, to, a, b);
  } else {
    leg = tmapTruckLeg_(from, to, profile || {}, a, b);
  }
  cache.map[key] = leg;
  cache.pending.push([date, pkey, a, b, leg.distanceM, leg.durationS, leg.source]);
  return leg;
}

function tmapTruckLeg_(from, to, profile, a, b) {
  var key = getProp_('TMAP_APP_KEY');
  if (!key) throw configError_('스크립트 속성 TMAP_APP_KEY가 없습니다. SK오픈API에서 TMAP 앱 키를 발급해 등록하세요.');
  var headers = {};
  headers[TMAP_TRUCK.keyHeader] = key;
  var r = fetchJsonWithRetry_(TMAP_TRUCK.url, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(TMAP_TRUCK.body(from, to, profile))
  }, '화물차경로');
  var leg = TMAP_TRUCK.parse(r);
  if (!leg) {
    logError_('화물차경로', a + ' → ' + b + ' 응답 해석 실패: ' + JSON.stringify(r).slice(0, 300));
    throw new Error('화물차 경로 응답을 해석할 수 없습니다(' + a + ' → ' + b + ').');
  }
  leg.source = 'tmap-truck';
  return leg;
}

function kakaoLeg_(from, to, a, b) {
  var url = KAKAO_DIRECTIONS + '?origin=' + from.lng + ',' + from.lat +
    '&destination=' + to.lng + ',' + to.lat + '&priority=RECOMMEND&summary=true';
  var r = kakaoGet_(url, '길찾기');
  var route = r.routes && r.routes[0];
  if (!route || route.result_code !== 0) {
    var msg = route ? route.result_code + ' ' + route.result_msg : '응답 없음';
    logError_('길찾기', a + ' → ' + b + ' 경로 없음: ' + msg);
    throw new Error('경로를 찾을 수 없습니다(' + a + ' → ' + b + '): ' + msg);
  }
  return { distanceM: route.summary.distance, durationS: route.summary.duration, source: 'kakao' };
}

/** 설정 누락처럼 모든 구간에서 똑같이 실패할 오류(구간 단위로 넘기지 않고 바로 중단) */
function configError_(msg) {
  var e = new Error(msg);
  e.config = true;
  return e;
}

/**
 * 지점 목록의 시간(분)·거리(km) 행렬. points[0]은 회사.
 * 경로를 못 찾은 구간(예: 높이 제한으로 진입 불가)은 Infinity로 두고 배차에서 제외한다.
 * 모든 구간이 실패하면 키·네트워크 문제로 보고 오류를 그대로 던진다.
 * @return {{time:number[][], dist:number[][], failed:string[]}}
 */
function buildMatrix(date, points, profile) {
  var n = points.length;
  var time = [];
  var dist = [];
  var failed = [];
  var tried = 0;
  var lastErr = null;
  try {
    for (var i = 0; i < n; i++) {
      time.push([]);
      dist.push([]);
      for (var j = 0; j < n; j++) {
        if (i === j) { time[i].push(0); dist[i].push(0); continue; }
        tried++;
        try {
          var leg = getLeg_(date, points[i], points[j], profile);
          time[i].push(leg.durationS / 60);
          dist[i].push(leg.distanceM / 1000);
        } catch (e) {
          if (e.config) throw e;
          lastErr = e;
          failed.push(i + '>' + j);
          time[i].push(Infinity);
          dist[i].push(Infinity);
        }
      }
    }
  } finally {
    flushLegCache_();
  }
  if (tried > 0 && failed.length === tried) throw lastErr;
  return { time: time, dist: dist, failed: failed };
}

/**
 * 차량별 행렬. 프로필이 같은 차량끼리는 같은 행렬을 공유해 API 호출을 줄인다.
 * @param {Object[]} vehicles [{id, profile}]
 * @return {Object} {차량ID: {time, dist}}
 */
function buildVehicleMatrices(date, points, vehicles) {
  var byProfile = {};
  var out = {};
  vehicles.forEach(function (v) {
    var k = v.profile.key;
    if (!byProfile[k]) byProfile[k] = buildMatrix(date, points, v.profile);
    out[v.id] = byProfile[k];
  });
  return out;
}

/**
 * 구간캐시에서 지난 날짜 행을 지운다(배차 계산 때 자동 실행).
 * 설정 탭 '구간캐시보관일수'(기본 0 = 오늘 것만 남김)만큼 지난 날짜도 남긴다.
 * 행을 하나씩 지우면 느리므로 남길 행만 모아 한 번에 다시 쓴다.
 * @return {number} 지운 행 수
 */
function pruneLegCache_(today) {
  var keep = toNumber(getProp_('LEG_CACHE_KEEP_DAYS'), 0);
  var cutoff = shiftDateKey_(today, -Math.max(0, Math.floor(keep)));
  var sh = getSheet_(SHEET.LEG_CACHE, HEADERS.LEG_CACHE);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2) return 0;
  var dateCol = headerIndex_(sh)['일자'];
  if (!dateCol) return 0;
  var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var kept = rows.filter(function (r) {
    var d = dateKey_(r[dateCol - 1]);
    return d === '' || d >= cutoff;
  });
  var removed = rows.length - kept.length;
  if (!removed) return 0;
  sh.getRange(2, 1, rows.length, lastCol).clearContent();
  if (kept.length) sh.getRange(2, 1, kept.length, lastCol).setValues(kept);
  if (legMemo_ && legMemo_.date < cutoff) legMemo_ = null;
  return removed;
}

/** 'yyyy-MM-dd'에 일수를 더한다 */
function shiftDateKey_(key, days) {
  var p = key.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
