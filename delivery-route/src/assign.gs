/**
 * assign.gs — 차량 배정과 회차 산정(순수 함수)
 *
 * 규칙(설계 문서 4장 / 이관 문서 5.1)
 *  1. 화물최대길이 ≤ 적재함길이 인 차량만 후보로 둔다.
 *  2. 회차당 최대적재중량을 넘지 않게 화물을 묶는다.
 *  3. 같은 회차에는 가까운 배송지를 모은다(총 소요시간 최소화로 자연스럽게 묶임).
 *  4. 운행시작 출발, 운행종료 이전 복귀 범위 안에서 회차를 배정한다.
 *  5. 시간 = 회차별 상차시간 + 이동시간 + 거래처 체류시간.
 *  6. 범위를 넘거나 후보 차량이 없으면 경고를 남긴다.
 *  7. 수동지정 행은 배정차량·회차를 유지한다.
 *
 * 방법: 탐욕 삽입으로 초기해를 만든 뒤 지역 탐색(이동·교환·회차 이전)으로 개선한다.
 * 목적함수 = 초과시간×10000 + 전체 차량 작업시간 합 + 0.1×가장 늦은 복귀시각
 */

/**
 * @param {Object} input
 *   deliveries: [{id, point, weight, length, stayMin, manual, vehicleId, trip}]
 *               point = 시간행렬 인덱스(0은 회사)
 *   vehicles:   [{id, maxWeight, bedLength}]
 *   time:       이동시간 행렬(분) — 모든 차량 공통
 *   timeByVehicle: {차량ID: 행렬} — 차량별 행렬(화물차 제한 반영). 있으면 time보다 우선
 *   dayStart, dayEnd: 자정 기준 분
 *   loadingMin: 회차별 상차시간(분)
 * @return {{rows:Object[], trips:Object[], warnings:string[]}}
 */
function planDeliveries(input) {
  var D = input.deliveries;
  var V = input.vehicles;
  function timeOf(vid) {
    return (input.timeByVehicle && input.timeByVehicle[vid]) || input.time;
  }
  var vehById = {};
  V.forEach(function (v) { vehById[v.id] = v; });

  var rowWarn = D.map(function () { return []; });
  var globalWarn = [];

  // --- 1. 후보 차량과 수동지정 처리 ---------------------------------------
  var cand = D.map(function (d, i) {
    var reachable = function (v) {
      var T = timeOf(v.id);
      return isFinite(T[0][d.point]) && isFinite(T[d.point][0]);
    };
    var fits = V.filter(function (v) {
      return d.length <= v.bedLength && d.weight <= v.maxWeight && reachable(v);
    }).map(function (v) { return v.id; });

    if (d.manual && d.vehicleId) {
      var mv = vehById[d.vehicleId];
      if (!mv) {
        rowWarn[i].push('수동지정 차량ID(' + d.vehicleId + ')가 차량 시트에 없음');
        return [];
      }
      if (d.length > mv.bedLength) rowWarn[i].push('수동지정 차량 적재함 길이 부족(' + d.length + 'mm > ' + mv.bedLength + 'mm)');
      if (d.weight > mv.maxWeight) rowWarn[i].push('수동지정 차량 적재중량 초과(' + d.weight + 'kg > ' + mv.maxWeight + 'kg)');
      if (!reachable(mv)) rowWarn[i].push('수동지정 차량이 진입할 경로 없음(높이·중량 제한 등)');
      return [d.vehicleId];
    }
    if (fits.length === 0) {
      var lenOk = V.some(function (v) { return d.length <= v.bedLength; });
      var loadOk = V.some(function (v) { return d.length <= v.bedLength && d.weight <= v.maxWeight; });
      rowWarn[i].push(!lenOk ? '적재 가능 차량 없음(화물 길이 초과) — 차량 추가 필요'
        : !loadOk ? '적재 가능 차량 없음(중량 초과) — 차량 추가 필요'
          : '실을 수 있는 차량이 진입할 경로 없음(높이·중량 제한 등) — 주소·차량 확인 필요');
    }
    return fits;
  });

  // --- 2. 수동지정(차량+회차) 고정 회차 구성 ------------------------------
  var trips = [];
  var lockedMap = {};
  D.forEach(function (d, i) {
    if (d.manual && d.vehicleId && d.trip && vehById[d.vehicleId]) {
      var key = d.vehicleId + '#' + d.trip;
      if (!lockedMap[key]) {
        lockedMap[key] = { vehicleId: d.vehicleId, members: [], locked: true, number: Number(d.trip) };
        trips.push(lockedMap[key]);
      }
      lockedMap[key].members.push(i);
    }
  });
  var isLocked = D.map(function (d) {
    return !!(d.manual && d.vehicleId && d.trip && vehById[d.vehicleId]);
  });

  // --- 경로 시간 계산(멤버 집합별 캐시) ------------------------------------
  var routeCache = {};
  function routeOf(members, vid) {
    var T = timeOf(vid);
    var key = vid + ':' + members.slice().sort(function (a, b) { return a - b; }).join(',');
    if (routeCache[key]) return routeCache[key];
    var k = members.length;
    var pts = [0].concat(members.map(function (m) { return D[m].point; }));
    var sub = [];
    for (var a = 0; a <= k; a++) {
      sub.push([]);
      for (var b = 0; b <= k; b++) sub[a].push(a === b ? 0 : T[pts[a]][pts[b]]);
    }
    var idx = [];
    for (var j = 1; j <= k; j++) idx.push(j);
    var r = optimizeRoute(idx, sub);
    var stay = members.reduce(function (s, m) { return s + D[m].stayMin; }, 0);
    var res = {
      order: r.order.map(function (j) { return members[j - 1]; }),
      travelMin: r.travelMin,
      routeMin: r.travelMin + stay
    };
    routeCache[key] = res;
    return res;
  }

  function weightOf(members) {
    return members.reduce(function (s, m) { return s + D[m].weight; }, 0);
  }

  function canJoin(trip, i) {
    if (trip.locked) return false;
    if (cand[i].indexOf(trip.vehicleId) < 0) return false;
    return weightOf(trip.members) + D[i].weight <= vehById[trip.vehicleId].maxWeight;
  }

  function tripFeasibleOn(members, vid) {
    for (var x = 0; x < members.length; x++) {
      if (cand[members[x]].indexOf(vid) < 0) return false;
    }
    return weightOf(members) <= vehById[vid].maxWeight;
  }

  function cost(ts) {
    var perVeh = {};
    var total = 0;
    ts.forEach(function (t) {
      if (!t.members.length) return;
      var dur = input.loadingMin + routeOf(t.members, t.vehicleId).routeMin;
      perVeh[t.vehicleId] = (perVeh[t.vehicleId] || 0) + dur;
      total += dur;
    });
    var over = 0;
    var latest = 0;
    Object.keys(perVeh).forEach(function (vid) {
      var finish = input.dayStart + perVeh[vid];
      over += Math.max(0, finish - input.dayEnd);
      latest = Math.max(latest, finish);
    });
    return over * 10000 + total + 0.1 * latest;
  }

  function clone(ts) {
    return ts.map(function (t) {
      return { vehicleId: t.vehicleId, members: t.members.slice(), locked: t.locked, number: t.number };
    });
  }

  function prune(ts) {
    return ts.filter(function (t) { return t.members.length > 0; });
  }

  // --- 3. 탐욕 삽입 초기해 -----------------------------------------------
  var order = [];
  D.forEach(function (d, i) { if (!isLocked[i] && cand[i].length) order.push(i); });
  order.sort(function (a, b) {
    return (cand[a].length - cand[b].length) || (D[b].weight - D[a].weight) || (a - b);
  });

  order.forEach(function (i) {
    var best = null;
    var bestCost = Infinity;
    for (var t = 0; t < trips.length; t++) {
      if (!canJoin(trips[t], i)) continue;
      var c1 = clone(trips);
      c1[t].members.push(i);
      var v1 = cost(c1);
      if (v1 < bestCost) { bestCost = v1; best = c1; }
    }
    cand[i].forEach(function (vid) {
      var c2 = clone(trips);
      c2.push({ vehicleId: vid, members: [i], locked: false, number: null });
      var v2 = cost(c2);
      if (v2 < bestCost) { bestCost = v2; best = c2; }
    });
    trips = best;
  });

  // --- 4. 지역 탐색 개선 ---------------------------------------------------
  var curCost = cost(trips);
  var EPS = 1e-6;
  for (var iter = 0; iter < 200; iter++) {
    var improved = false;

    // (a) 배송지 하나를 다른 회차 또는 새 회차로 이동
    for (var t1 = 0; t1 < trips.length && !improved; t1++) {
      if (trips[t1].locked) continue;
      for (var mi = 0; mi < trips[t1].members.length && !improved; mi++) {
        var d = trips[t1].members[mi];
        for (var t2 = 0; t2 <= trips.length && !improved; t2++) {
          if (t2 === t1) continue;
          var targets = t2 < trips.length ? [null] : cand[d];
          for (var q = 0; q < targets.length && !improved; q++) {
            var c = clone(trips);
            c[t1].members.splice(mi, 1);
            if (t2 < trips.length) {
              if (!canJoin(trips[t2], d)) continue;
              c[t2].members.push(d);
            } else {
              if (trips[t1].members.length === 1 && targets[q] === trips[t1].vehicleId) continue;
              c.push({ vehicleId: targets[q], members: [d], locked: false, number: null });
            }
            c = prune(c);
            var cc = cost(c);
            if (cc < curCost - EPS) { trips = c; curCost = cc; improved = true; }
          }
        }
      }
    }

    // (b) 서로 다른 회차의 배송지 두 개 교환
    for (var a1 = 0; a1 < trips.length && !improved; a1++) {
      if (trips[a1].locked) continue;
      for (var a2 = a1 + 1; a2 < trips.length && !improved; a2++) {
        if (trips[a2].locked) continue;
        for (var x = 0; x < trips[a1].members.length && !improved; x++) {
          for (var y = 0; y < trips[a2].members.length && !improved; y++) {
            var s = clone(trips);
            var dx = s[a1].members[x];
            var dy = s[a2].members[y];
            s[a1].members[x] = dy;
            s[a2].members[y] = dx;
            if (!tripFeasibleOn(s[a1].members, s[a1].vehicleId)) continue;
            if (!tripFeasibleOn(s[a2].members, s[a2].vehicleId)) continue;
            var sc = cost(s);
            if (sc < curCost - EPS) { trips = s; curCost = sc; improved = true; }
          }
        }
      }
    }

    // (c) 회차 전체를 다른 차량으로 이전
    for (var b1 = 0; b1 < trips.length && !improved; b1++) {
      if (trips[b1].locked) continue;
      for (var vi = 0; vi < V.length && !improved; vi++) {
        var vid2 = V[vi].id;
        if (vid2 === trips[b1].vehicleId) continue;
        if (!tripFeasibleOn(trips[b1].members, vid2)) continue;
        var m = clone(trips);
        m[b1].vehicleId = vid2;
        var mc = cost(m);
        if (mc < curCost - EPS) { trips = m; curCost = mc; improved = true; }
      }
    }

    if (!improved) break;
  }

  // --- 5. 회차 번호 부여와 시간표 계산 ------------------------------------
  var rows = D.map(function (d) {
    return { id: d.id, vehicleId: '', trip: '', seq: '', etaMin: null, warnings: [] };
  });
  var outTrips = [];

  V.forEach(function (v) {
    var mine = trips.filter(function (t) { return t.vehicleId === v.id && t.members.length; });
    if (!mine.length) return;
    var used = {};
    mine.forEach(function (t) { if (t.locked) used[t.number] = true; });
    var autos = mine.filter(function (t) { return !t.locked; });
    // 결과가 매번 같도록 회차 안 최소 행 번호 기준으로 정렬
    autos.sort(function (p, q) { return Math.min.apply(null, p.members) - Math.min.apply(null, q.members); });
    var next = 1;
    autos.forEach(function (t) {
      while (used[next]) next++;
      t.number = next;
      used[next] = true;
    });
    mine.sort(function (p, q) { return p.number - q.number; });

    var clock = input.dayStart;
    var T = timeOf(v.id);
    mine.forEach(function (t) {
      var r = routeOf(t.members, v.id);
      var loadStart = clock;
      var depart = clock + input.loadingMin;
      var now = depart;
      var prevPt = 0;
      r.order.forEach(function (m, k) {
        now += k === 0 ? T[0][D[m].point] : T[prevPt][D[m].point];
        rows[m].vehicleId = v.id;
        rows[m].trip = t.number;
        rows[m].seq = k + 1;
        rows[m].etaMin = now;
        now += D[m].stayMin;
        prevPt = D[m].point;
      });
      var ret = now + T[prevPt][0];
      var wsum = weightOf(t.members);
      var tripWarn = [];
      if (ret > input.dayEnd) {
        tripWarn.push('복귀 예정 ' + formatMinutes(ret) + '(운행종료 ' + formatMinutes(input.dayEnd) + ' 초과) — 차량 추가 필요');
      }
      if (t.locked && wsum > v.maxWeight) {
        tripWarn.push('수동지정 회차 중량 합계 초과(' + wsum + 'kg > ' + v.maxWeight + 'kg)');
      }
      t.members.forEach(function (m) {
        rows[m].warnings = rowWarn[m].concat(tripWarn);
      });
      outTrips.push({
        vehicleId: v.id,
        trip: t.number,
        order: r.order.map(function (m) { return D[m].id; }),
        loadStartMin: loadStart,
        departMin: depart,
        returnMin: ret,
        travelMin: r.travelMin,
        totalMin: ret - loadStart,
        weight: wsum,
        locked: !!t.locked,
        warnings: tripWarn
      });
      clock = ret;
    });
  });

  // 배정되지 않은 행의 경고
  D.forEach(function (d, i) {
    if (rows[i].vehicleId === '') rows[i].warnings = rowWarn[i];
  });

  var overTrips = outTrips.filter(function (t) { return t.returnMin > input.dayEnd; }).length;
  if (overTrips) globalWarn.push('운행종료 이후 복귀 회차 ' + overTrips + '개 — 차량 추가 필요');
  var unassigned = rows.filter(function (r) { return r.vehicleId === ''; }).length;
  if (unassigned) globalWarn.push('배정 불가 배송 ' + unassigned + '건');

  return { rows: rows, trips: outTrips, warnings: globalWarn };
}
