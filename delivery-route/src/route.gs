/**
 * route.gs — 회차별 순환 경로 최적화(회사 → 배송지들 → 회사)
 *
 * 행렬 인덱스 0은 회사, 1..N은 배송지 지점이다.
 * time[i][j]는 i→j 이동시간(분). 비대칭 행렬도 지원한다.
 * 체류시간은 방문 순서와 무관한 상수이므로 이동시간 합계만 최소화한다.
 */

/**
 * 방문할 지점 목록에 대해 최단 시간 순서를 구한다.
 * @param {number[]} points  행렬 인덱스 목록(0 제외)
 * @param {number[][]} time  이동시간 행렬(분)
 * @return {{order:number[], travelMin:number, method:string}}
 */
function optimizeRoute(points, time) {
  var n = points.length;
  if (n === 0) return { order: [], travelMin: 0, method: 'empty' };
  if (n === 1) {
    return { order: points.slice(), travelMin: time[0][points[0]] + time[points[0]][0], method: 'single' };
  }
  if (n <= EXACT_ROUTE_LIMIT) return exactRoute_(points, time);
  return heuristicRoute_(points, time);
}

/** 순서대로 방문했을 때의 순환 이동시간 */
function tourTime(order, time) {
  if (order.length === 0) return 0;
  var sum = time[0][order[0]];
  for (var i = 1; i < order.length; i++) sum += time[order[i - 1]][order[i]];
  return sum + time[order[order.length - 1]][0];
}

/** 순열 전수 탐색(분기 한정으로 불필요한 가지를 잘라 속도를 높인다) */
function exactRoute_(points, time) {
  var n = points.length;
  var best = Infinity;
  var bestOrder = null;
  var used = [];
  var path = [];
  for (var k = 0; k < n; k++) used.push(false);

  function dfs(last, acc) {
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
      used[i] = true;
      path.push(points[i]);
      dfs(points[i], acc + time[last][points[i]]);
      path.pop();
      used[i] = false;
    }
  }
  dfs(0, 0);
  // 모든 순서가 진입 불가(Infinity) 구간을 포함하면 입력 순서를 그대로 돌려준다
  if (!bestOrder) return { order: points.slice(), travelMin: Infinity, method: 'exact' };
  return { order: bestOrder, travelMin: best, method: 'exact' };
}

/** 최근접 이웃으로 초기해를 만들고 2-opt로 개선 */
function heuristicRoute_(points, time) {
  var remaining = points.slice();
  var order = [];
  var cur = 0;
  while (remaining.length) {
    var bi = 0;
    for (var i = 1; i < remaining.length; i++) {
      if (time[cur][remaining[i]] < time[cur][remaining[bi]]) bi = i;
    }
    cur = remaining.splice(bi, 1)[0];
    order.push(cur);
  }
  var best = tourTime(order, time);
  var improved = true;
  while (improved) {
    improved = false;
    for (var a = 0; a < order.length - 1; a++) {
      for (var b = a + 1; b < order.length; b++) {
        // 구간 a..b를 뒤집는다(비대칭 행렬이므로 전체 시간을 다시 계산)
        var cand = order.slice(0, a).concat(order.slice(a, b + 1).reverse(), order.slice(b + 1));
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
