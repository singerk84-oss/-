/**
 * matrix.gs — 구간 거리·시간 행렬(카카오모빌리티 길찾기 API)
 *
 * 같은 날 같은 좌표쌍은 '구간캐시' 시트에서 재사용해 API 호출을 줄인다.
 * 스크립트 속성 DISTANCE_MODE=estimate 이면 API 없이 직선거리 기반으로 추정한다(시험용).
 */

var KAKAO_DIRECTIONS = 'https://apis-navi.kakaomobility.com/v1/directions';

/** 한 번의 실행 안에서 쓰는 메모리 캐시 */
var legMemo_ = null;

function loadLegCache_(date) {
  if (legMemo_ && legMemo_.date === date) return legMemo_;
  var map = {};
  readTable_(SHEET.LEG_CACHE, HEADERS.LEG_CACHE).forEach(function (r) {
    if (dateKey_(r['일자']) !== date) return;
    map[r['출발좌표'] + '>' + r['도착좌표']] = {
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
 * 구간 1개의 거리·시간. from/to = {lat, lng}
 * @return {{distanceM:number, durationS:number, source:string}}
 */
function getLeg_(date, from, to) {
  var a = coordKey(from.lat, from.lng);
  var b = coordKey(to.lat, to.lng);
  if (a === b) return { distanceM: 0, durationS: 0, source: 'same' };
  var cache = loadLegCache_(date);
  var key = a + '>' + b;
  if (cache.map[key]) return cache.map[key];

  var leg;
  if (getProp_('DISTANCE_MODE') === 'estimate') {
    var km = haversineKm(from.lat, from.lng, to.lat, to.lng) * ESTIMATE_ROAD_FACTOR;
    leg = { distanceM: Math.round(km * 1000), durationS: Math.round(km / ESTIMATE_SPEED_KMH * 3600), source: 'estimate' };
  } else {
    var url = KAKAO_DIRECTIONS + '?origin=' + from.lng + ',' + from.lat +
      '&destination=' + to.lng + ',' + to.lat + '&priority=RECOMMEND&summary=true';
    var r = kakaoGet_(url, '길찾기');
    var route = r.routes && r.routes[0];
    if (!route || route.result_code !== 0) {
      var msg = route ? route.result_code + ' ' + route.result_msg : '응답 없음';
      logError_('길찾기', a + ' → ' + b + ' 경로 없음: ' + msg);
      throw new Error('경로를 찾을 수 없습니다(' + a + ' → ' + b + '): ' + msg);
    }
    leg = { distanceM: route.summary.distance, durationS: route.summary.duration, source: 'kakao' };
  }
  cache.map[key] = leg;
  cache.pending.push([date, a, b, leg.distanceM, leg.durationS, leg.source]);
  return leg;
}

/**
 * 지점 목록의 시간(분)·거리(km) 행렬. points[0]은 회사.
 * @return {{time:number[][], dist:number[][]}}
 */
function buildMatrix(date, points) {
  var n = points.length;
  var time = [];
  var dist = [];
  try {
    for (var i = 0; i < n; i++) {
      time.push([]);
      dist.push([]);
      for (var j = 0; j < n; j++) {
        if (i === j) { time[i].push(0); dist[i].push(0); continue; }
        var leg = getLeg_(date, points[i], points[j]);
        time[i].push(leg.durationS / 60);
        dist[i].push(leg.distanceM / 1000);
      }
    }
  } finally {
    flushLegCache_();
  }
  return { time: time, dist: dist };
}
