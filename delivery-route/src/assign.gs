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
 *   deliveries: [{id, point, weight, length, stayMin, manual, vehicleId, trip, kind, priority}]
 *               point = 시간행렬 인덱스(0은 회사)
 *               kind = 'delivery'(배송, 기본) | 'pickup'(매입: 경유 중 싣고 회사로 가져옴)
 *               priority = 우선 배송(차량 1회차에 넣고, 회차 안에서 먼저 방문)
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
    // 짐칸 조건: 배송 화물을 모두 싣고 출발, 배송지에서 내리고 매입처에서 싣는다
    var delta = {};
    var priority = {};
    var initialLoad = 0;
    members.forEach(function (m, x) {
      if (isPickup(m)) delta[x + 1] = D[m].weight;
      else { delta[x + 1] = -D[m].weight; initialLoad += D[m].weight; }
      if (isPriority(m)) priority[x + 1] = true;
    });
    var r = optimizeRoute(idx, sub, {
      cap: vehById[vid].maxWeight, initialLoad: initialLoad, delta: delta, priority: priority
    });
    var stay = members.reduce(function (s, m) { return s + D[m].stayMin; }, 0);
    var res = {
      order: r.order.map(function (j) { return members[j - 1]; }),
      travelMin: r.travelMin,
      routeMin: r.travelMin + stay
    };
    routeCache[key] = res;
    return res;
  }

  function isPickup(m) { return D[m].kind === 'pickup'; }
  function isPriority(m) { return !!D[m].priority && !isPickup(m); }

  /** {deliver: 배송 합계, pickup: 매입 합계} */
  function weightOf(members) {
    var w = { deliver: 0, pickup: 0 };
    members.forEach(function (m) {
      if (isPickup(m)) w.pickup += D[m].weight; else w.deliver += D[m].weight;
    });
    return w;
  }

  /**
   * 배송 합계와 매입 합계가 각각 최대적재중량 이하이면 회차가 성립한다
   * ('배송을 모두 끝낸 뒤 매입' 순서는 항상 가능하므로). 실제 순서는 routeOf가
   * 경유지마다 짐칸 무게를 따져 더 빠른 순서(중간 매입 포함)를 고른다.
   */
  function weightOk(members, vid) {
    var w = weightOf(members);
    var cap = vehById[vid].maxWeight;
    return w.deliver <= cap && w.pickup <= cap;
  }

  function canJoin(trip, i) {
    if (trip.locked) return false;
    if (cand[i].indexOf(trip.vehicleId) < 0) return false;
    return weightOk(trip.members.concat([i]), trip.vehicleId);
  }

  function tripFeasibleOn(members, vid) {
    for (var x = 0; x < members.length; x++) {
      if (cand[members[x]].indexOf(vid) < 0) return false;
    }
    return weightOk(members, vid);
  }

  function hasPriority(t) {
    return t.members.some(isPriority);
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
    // 우선 배송은 차량 1회차에만: 우선 건이 든 회차가 차량당 2개 이상이거나,
    // 수동지정 1회차가 따로 있는데 자동 회차에 우선 건이 있으면 위반
    var priViolation = 0;
    var priTrips = {};
    var locked1 = {};
    ts.forEach(function (t) {
      if (!t.members.length) return;
      if (t.locked && t.number === 1) locked1[t.vehicleId] = t;
      if (hasPriority(t)) (priTrips[t.vehicleId] = priTrips[t.vehicleId] || []).push(t);
    });
    Object.keys(priTrips).forEach(function (vid) {
      var list = priTrips[vid];
      var ok = locked1[vid] ? list.filter(function (t) { return t === locked1[vid]; }).length : Math.min(list.length, 1);
      list.forEach(function (t) {
        if (ok > 0 && (!locked1[vid] || t === locked1[vid])) { ok--; return; }
        priViolation += t.members.filter(isPriority).length;
      });
    });
    return over * 10000 + priViolation * 5000 + total + 0.1 * latest;
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
    // 우선 배송이 든 회차를 앞에, 나머지는 결과가 매번 같도록 회차 안 최소 행 번호 기준으로 정렬
    autos.sort(function (p, q) {
      return (hasPriority(q) - hasPriority(p)) ||
        (Math.min.apply(null, p.members) - Math.min.apply(null, q.members));
    });
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
      if (t.locked && wsum.deliver > v.maxWeight) {
        tripWarn.push('수동지정 회차 배송 중량 합계 초과(' + wsum.deliver + 'kg > ' + v.maxWeight + 'kg)');
      }
      if (t.locked && wsum.pickup > v.maxWeight) {
        tripWarn.push('수동지정 회차 매입 중량 합계 초과(' + wsum.pickup + 'kg > ' + v.maxWeight + 'kg)');
      }
      t.members.forEach(function (m) {
        var w = rowWarn[m].concat(tripWarn);
        if (isPriority(m) && t.number !== 1) w.push('우선 배송을 1회차에 넣지 못함(' + t.number + '회차)');
        rows[m].warnings = w;
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
        weight: wsum.deliver,
        pickupWeight: wsum.pickup,
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

/**
 * 운행 중 매입 추가: 이미 확정된 회차에 매입 1건을 끼워 넣을 가장 좋은 자리를 찾는다(순수 함수).
 *
 * 규칙
 *  - 완료된 회차는 제외. 이미 지난(완료·출발한) 경유지 앞에는 넣지 않는다.
 *    단, 회사로 복귀 중(복귀 출발)인 회차는 복귀 직전에 넣을 수 있다(귀사길 매입).
 *  - 경유지마다 짐칸 무게가 최대적재중량을 넘지 않아야 한다.
 *  - 넣은 뒤 그 차량의 하루 마지막 복귀가 운행종료 이내여야 한다(뒤 회차도 그만큼 밀린다).
 *  - 기존 경유지 순서는 바꾸지 않는다(기사가 보던 순서 유지). 추가 시간이 가장 적은 자리를 고른다.
 *  - 어디에도 못 넣으면 그 차량 마지막 회차 뒤에 매입 전용 회차를 만드는 안을 검토한다.
 *
 * @param {Object} input
 *   item:     {point, weight, length, stayMin}
 *   vehicles: [{id, maxWeight, bedLength}]
 *   legTime(vehicleId, fromPoint, toPoint) → 분(진입 불가면 Infinity). 지점 0은 회사
 *   trips:    [{vehicleId, trip, done,
 *               stops:[{point, kind, weight, stayMin, done, departed}]}]  (회사 복귀 제외, 방문 순서)
 *   lastReturnByVehicle: {차량ID: 그날 마지막 복귀 예정(분)} — 회차가 없는 차량은 생략
 *   dayStart, dayEnd, loadingMin
 *   nowMin(선택): 현재 시각(분). 새 회차는 이 시각과 마지막 복귀 중 늦은 때부터 상차한다
 * @return {Object|null} {type:'insert', vehicleId, trip, position, deltaMin}
 *                       | {type:'new', vehicleId, trip, departMin, returnMin, deltaMin} | {type:'none', reason}
 */
function planPickupInsertion(input) {
  var it = input.item;
  var best = null;
  var reasons = { length: true, weight: true, time: false, load: false, route: false };

  input.vehicles.forEach(function (v) {
    if (it.length > v.bedLength) return;
    reasons.length = false;
    if (it.weight > v.maxWeight) return;
    reasons.weight = false;
    var lt = function (a, b) { return a === b ? 0 : input.legTime(v.id, a, b); };
    var lastReturn = input.lastReturnByVehicle[v.id];
    if (lastReturn === undefined) lastReturn = input.dayStart;

    input.trips.forEach(function (t) {
      if (t.vehicleId !== v.id || t.done) return;
      var S = t.stops;
      // 넣을 수 있는 첫 자리: 아직 출발하지 않은 첫 경유지 앞
      var minPos = 0;
      for (var k = 0; k < S.length; k++) {
        if (S[k].done || S[k].departed) minPos = k + 1;
      }
      if (minPos > S.length) minPos = S.length;
      // 회사 복귀 중이면 복귀 직전(=마지막 자리)만 가능, 그 외에는 minPos..S.length
      for (var pos = minPos; pos <= S.length; pos++) {
        // 짐칸 무게 검사
        var load = 0;
        S.forEach(function (s) { if (s.kind !== 'pickup') load += s.weight; });
        var ok = load <= v.maxWeight;
        for (var q = 0; q <= S.length && ok; q++) {
          if (q === pos) { load += it.weight; if (load > v.maxWeight) ok = false; }
          if (q < S.length && ok) {
            load += S[q].kind === 'pickup' ? S[q].weight : -S[q].weight;
            if (load > v.maxWeight) ok = false;
          }
        }
        if (!ok) { reasons.load = true; continue; }
        var prev = pos === 0 ? 0 : S[pos - 1].point;
        var next = pos < S.length ? S[pos].point : 0;
        var delta = lt(prev, it.point) + it.stayMin + lt(it.point, next) - lt(prev, next);
        if (!isFinite(delta)) { reasons.route = true; continue; }
        if (lastReturn + delta > input.dayEnd) { reasons.time = true; continue; }
        if (!best || delta < best.deltaMin - 1e-9) {
          best = { type: 'insert', vehicleId: v.id, trip: t.trip, position: pos, deltaMin: delta };
        }
      }
    });

    // 매입 전용 새 회차(마지막 회차 뒤, 지금보다 이르지 않게)
    var depart = Math.max(lastReturn, input.nowMin || 0) + input.loadingMin;
    var round = lt(0, it.point) + it.stayMin + lt(it.point, 0);
    if (!isFinite(round)) { reasons.route = true; return; }
    var ret = depart + round;
    if (ret > input.dayEnd) { reasons.time = true; return; }
    var maxTrip = 0;
    input.trips.forEach(function (t) { if (t.vehicleId === v.id) maxTrip = Math.max(maxTrip, Number(t.trip)); });
    var d2 = input.loadingMin + round;
    if (!best || d2 < best.deltaMin - 1e-9) {
      best = { type: 'new', vehicleId: v.id, trip: maxTrip + 1, departMin: depart, returnMin: ret, deltaMin: d2 };
    }
  });

  if (best) return best;
  var reason = reasons.length ? '적재함 길이 초과'
    : reasons.weight ? '최대적재중량 초과'
      : reasons.route ? '진입할 경로 없음'
        : reasons.time ? '운행종료 전 복귀 불가 — 차량 추가 필요'
          : reasons.load ? '짐칸 여유 없음' : '추가할 수 있는 회차 없음';
  return { type: 'none', reason: reason };
}
