/**
 * route.gs — 회차별 순환 경로 최적화(회사 → 경유지들 → 회사)
 *
 * 행렬 인덱스 0은 회사, 그 외는 경유지(배송지·매입처)다.
 * time[i][j]는 i→j 이동시간(분). 비대칭 행렬도 지원한다.
 * 체류시간은 방문 순서와 무관한 상수이므로 이동시간 합계만 최소화한다.
 *
 * 선택 조건(opts)
 *   cap, initialLoad, delta[지점] : 짐칸 무게. 출발 때 initialLoad(배송 화물 합계)를 싣고,
 *                                   배송지에서는 delta<0(내림), 매입처에서는 delta>0(실음).
 *                                   어느 지점에서도 실린 무게가 cap을 넘으면 안 된다.
 *   priority[지점] = true          : 우선 배송. 우선 지점을 모두 방문한 뒤에 나머지를 방문한다.
 */

/**
 * @param {number[]} points  행렬 인덱스 목록(0 제외, 중복 없음)
 * @param {number[][]} time  이동시간 행렬(분)
 * @param {Object=} opts     위 선택 조건
 * @return {{order:number[], travelMin:number, method:string}}
 */
function optimizeRoute(points, time, opts) {
  opts = opts || {};
  var n = points.length;
  if (n === 0) return { order: [], travelMin: 0, method: 'empty' };
  if (n === 1) {
    return { order: points.slice(), travelMin: time[0][points[0]] + time[points[0]][0], method: 'single' };
  }
  if (n <= EXACT_ROUTE_LIMIT) return exactRoute_(points, time, opts);
  return heuristicRoute_(points, time, opts);
}

/** 순서대로 방문했을 때의 순환 이동시간 */
function tourTime(order, time) {
  if (order.length === 0) return 0;
  var sum = time[0][order[0]];
  for (var i = 1; i < order.length; i++) sum += time[order[i - 1]][order[i]];
  return sum + time[order[order.length - 1]][0];
}

/** 순서가 무게·우선 조건을 지키는지 */
function routeFeasible(order, opts) {
  opts = opts || {};
  var pri = opts.priority || {};
  var seenNormal = false;
  var load = opts.initialLoad || 0;
  var hasCap = opts.cap !== undefined && opts.cap !== null;
  if (hasCap && load > opts.cap + 1e-9) return false;
  for (var i = 0; i < order.length; i++) {
    var p = order[i];
    if (pri[p]) { if (seenNormal) return false; } else seenNormal = true;
    if (hasCap) {
      load += (opts.delta && opts.delta[p]) || 0;
      if (load > opts.cap + 1e-9) return false;
    }
  }
  return true;
}

/** 조건을 항상 만족하는 기본 순서: 우선 배송 → 일반 배송 → 매입 */
function safeOrder_(points, opts) {
  var pri = opts.priority || {};
  var delta = opts.delta || {};
  var rank = function (p) { return pri[p] ? 0 : (delta[p] > 0 ? 2 : 1); };
  return points.slice().sort(function (a, b) { return rank(a) - rank(b); });
}

/** 순열 전수 탐색(분기 한정 + 조건 위반 가지 제거) */
function exactRoute_(points, time, opts) {
  var n = points.length;
  var pri = opts.priority || {};
  var delta = opts.delta || {};
  var hasCap = opts.cap !== undefined && opts.cap !== null;
  var priLeft = points.filter(function (p) { return pri[p]; }).length;
  var best = Infinity;
  var bestOrder = null;
  var used = [];
  var path = [];
  for (var k = 0; k < n; k++) used.push(false);

  function dfs(last, acc, load) {
    if (acc >= best) return;
    if (path.length === n) {
      var total = acc + time[last][0];
      if (total < best) {
        best = total;
        bestOrder = path.slice();
      }
      return;
    }
    for (var i = 0; i < n; i++) {
      if (used[i]) continue;
      var p = points[i];
      if (priLeft > 0 && !pri[p]) continue;          // 우선 지점이 남아 있으면 우선 지점만
      var nl = load + (delta[p] || 0);
      if (hasCap && nl > opts.cap + 1e-9) continue;   // 짐칸 초과
      used[i] = true;
      path.push(p);
      if (pri[p]) priLeft--;
      dfs(p, acc + time[last][p], nl);
      if (pri[p]) priLeft++;
      path.pop();
      used[i] = false;
    }
  }
  dfs(0, 0, opts.initialLoad || 0);
  if (!bestOrder) {
    // 모든 순서가 진입 불가(Infinity) 구간을 포함하는 경우
    var fb = safeOrder_(points, opts);
    return { order: fb, travelMin: tourTime(fb, time), method: 'exact' };
  }
  return { order: bestOrder, travelMin: best, method: 'exact' };
}

/** 조건을 지키는 최근접 이웃으로 초기해를 만들고, 조건을 지키는 2-opt로 개선 */
function heuristicRoute_(points, time, opts) {
  var pri = opts.priority || {};
  var delta = opts.delta || {};
  var hasCap = opts.cap !== undefined && opts.cap !== null;
  var remaining = points.slice();
  var order = [];
  var cur = 0;
  var load = opts.initialLoad || 0;
  var stuck = false;
  while (remaining.length) {
    var priLeft = remaining.some(function (p) { return pri[p]; });
    var bi = -1;
    for (var i = 0; i < remaining.length; i++) {
      var p = remaining[i];
      if (priLeft && !pri[p]) continue;
      if (hasCap && load + (delta[p] || 0) > opts.cap + 1e-9) continue;
      if (bi < 0 || time[cur][p] < time[cur][remaining[bi]]) bi = i;
    }
    if (bi < 0) { stuck = true; break; }
    cur = remaining.splice(bi, 1)[0];
    load += delta[cur] || 0;
    order.push(cur);
  }
  if (stuck) order = safeOrder_(points, opts);

  var best = tourTime(order, time);
  var improved = true;
  while (improved) {
    improved = false;
    for (var a = 0; a < order.length - 1; a++) {
      for (var b = a + 1; b < order.length; b++) {
        var cand = order.slice(0, a).concat(order.slice(a, b + 1).reverse(), order.slice(b + 1));
        if (!routeFeasible(cand, opts)) continue;
        var t = tourTime(cand, time);
        if (t < best - 1e-9) {
          order = cand;
          best = t;
          improved = true;
        }
      }
    }
  }
  return { order: order, travelMin: best, method: 'nn-2opt' };
}
