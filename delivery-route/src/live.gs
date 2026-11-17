/**
 * live.gs — 운행 중 매입 추가
 *
 * 사용법: 오늘배송 탭에 새 행을 넣고 구분을 '매입'으로, 배정차량ID는 비워 둔 뒤
 *         메뉴 [⑤ 운행 중 매입 추가]를 누른다.
 * 처리:   이미 확정·운행 중인 회차의 남은 경유지 사이(또는 복귀 직전)에 가장 적게 도는 자리로 끼워 넣는다.
 *         기존 링크가 그대로 쓰이고, 기사 화면은 자동으로 다시 읽어 새 경유지를 보여 준다.
 *         넣을 회차가 없으면 매입 전용 새 회차를 만든다(이 경우만 새 링크를 보내야 한다).
 */

function menuAddPickupsLive() {
  var date = todayKey_();
  var r = addPickupsLive(date);
  alert_(r.lines.length ? r.lines.join('\n') : '추가할 매입 행이 없습니다.\n\n' + pickupDiagnosis_(date) +
    '\n\n오늘배송 탭에 일자=오늘, 구분=매입, 배정차량ID가 빈 행을 넣고 다시 실행하세요.' +
    '\n(셀을 입력 중인 상태에서 메뉴를 누르면 값이 저장되기 전이라 인식되지 않습니다. Enter로 입력을 마친 뒤 실행하세요.)');
}

/** 추가할 행을 못 찾았을 때 무엇을 보았는지 알려 준다 */
function pickupDiagnosis_(date) {
  var rows = readTable_(SHEET.TODAY);
  var today = rows.filter(function (r) { return dateKey_(r['일자']) === date; });
  var pick = today.filter(isPickupRow_);
  var assigned = pick.filter(function (r) { return String(r['배정차량ID'] || '').trim() !== ''; });
  var lines = ['확인 결과(기준 일자 ' + date + ')',
    '- 오늘배송 전체 ' + rows.length + '행, 그중 오늘 일자 ' + today.length + '행',
    '- 구분=매입 ' + pick.length + '행(이미 배정됨 ' + assigned.length + '행)'];
  var odd = rows.filter(function (r) { return dateKey_(r['일자']) !== date && isPickupRow_(r); });
  if (odd.length) {
    lines.push('- 일자가 오늘이 아닌 매입 행: ' + odd.map(function (r) {
      return r._row + '행(' + (dateKey_(r['일자']) || '빈 일자') + ')';
    }).join(', '));
  }
  var kinds = {};
  today.forEach(function (r) { var k = String(r['구분'] === undefined ? '(칸 없음)' : r['구분']).trim() || '(빈칸)'; kinds[k] = (kinds[k] || 0) + 1; });
  lines.push('- 오늘 행의 구분 값: ' + Object.keys(kinds).map(function (k) { return k + ' ' + kinds[k]; }).join(', '));
  return lines.join('\n');
}

/** @return {{lines:string[], results:Object[]}} */
function addPickupsLive(date) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureOptionalColumns_();
    var pending = readTable_(SHEET.TODAY).filter(function (r) {
      return dateKey_(r['일자']) === date && isPickupRow_(r) && String(r['배정차량ID'] || '').trim() === '' &&
        String(r['거래처명'] || '').trim() !== '';
    });
    if (!pending.length) return { lines: [], results: [] };
    if (!readTable_(SHEET.TRIPS, HEADERS.TRIPS).some(function (t) { return dateKey_(t['일자']) === date; })) {
      throw new Error('오늘 배차가 아직 없습니다. 운행 전이면 [③ 배차·경로 계산]으로 매입까지 함께 계산하세요.');
    }
    geocodeAll(); // 새 매입처 좌표가 비어 있으면 채운다
    var lines = [];
    var results = [];
    pending.forEach(function (row) {
      var res = insertOnePickup_(date, row._row);
      results.push(res);
      lines.push(res.message);
    });
    flushLegCache_();
    safeSyncTripWaypoints_(date);
    return { lines: lines, results: results };
  } finally {
    lock.releaseLock();
  }
}

/** 매입 1건 처리(시트를 매번 새로 읽는다 — 앞 건 삽입으로 행 번호가 바뀌므로) */
function insertOnePickup_(date, todayRowNum) {
  var s = readSettings_();
  var todaySh = getSheet_(SHEET.TODAY);
  var allToday = readTable_(SHEET.TODAY);
  var row = allToday.filter(function (r) { return r._row === todayRowNum; })[0];
  var name = String(row['거래처명']).trim();

  var customers = {};
  readTable_(SHEET.CUSTOMERS).forEach(function (c) {
    customers[String(c['거래처명']).trim()] = {
      lat: toNumber(c['위도'], null), lng: toNumber(c['경도'], null),
      stayMin: toNumber(c['체류시간(분)'], s.defaultStayMin)
    };
  });
  var cust = customers[name];
  if (!cust || cust.lat === null) {
    var why = !cust ? '거래처 시트에 없는 거래처' : '거래처 좌표 없음(주소 확인)';
    updateRow_(todaySh, todayRowNum, { '경고': '운행 중 추가 불가: ' + why });
    return { ok: false, message: name + ': 추가 불가 — ' + why };
  }

  var vehicles = readTable_(SHEET.VEHICLES).filter(function (r) { return r['차량ID'] !== ''; }).map(function (r) {
    return {
      id: String(r['차량ID']).trim(),
      maxWeight: toNumber(r['최대적재중량(kg)'], 0),
      bedLength: toNumber(r['적재함길이(mm)'], 0),
      profile: vehicleProfile_(r)
    };
  });
  var vehById = {};
  vehicles.forEach(function (v) { vehById[v.id] = v; });

  // 지점: 0 = 회사
  var P = [{ lat: s.companyLat, lng: s.companyLng }];
  var pointOfName = {};
  function pointOf(n) {
    if (n === RETURN_LABEL) return 0;
    if (pointOfName[n] === undefined) {
      var c = customers[n];
      pointOfName[n] = P.length;
      P.push({ lat: c ? c.lat : null, lng: c ? c.lng : null });
    }
    return pointOfName[n];
  }

  // 오늘 회차 구성
  var tripRows = readTable_(SHEET.TRIPS, HEADERS.TRIPS).filter(function (t) { return dateKey_(t['일자']) === date; });
  var lastReturnByVehicle = {};
  var trips = tripRows.map(function (t) {
    var vid = String(t['차량ID']);
    var logs = tripLogRows_(date, vid, t['회차']);
    var plan = tripTodayRows_(date, vid, t['회차'], allToday);
    var ret = toMinutes(t['복귀예정']);
    if (ret !== null) lastReturnByVehicle[vid] = Math.max(lastReturnByVehicle[vid] || 0, ret);
    var stops = logs.filter(function (l) { return String(l['거래처명']).trim() !== RETURN_LABEL; }).map(function (l, k) {
      var n = String(l['거래처명']).trim();
      var pr = plan[k] || {};
      return {
        name: n,
        point: pointOf(n),
        kind: String(l['구분']).trim() === KIND_PICKUP ? 'pickup' : 'delivery',
        weight: toNumber(pr['화물중량(kg)'], 0),
        stayMin: (customers[n] || {}).stayMin || s.defaultStayMin,
        done: l['완료시각'] !== '',
        departed: l['출발시각'] !== ''
      };
    });
    return {
      vehicleId: vid, trip: Number(t['회차']), done: t['상태'] === '완료', returnMin: ret, stops: stops,
      tripRow: t, logs: logs, plan: plan
    };
  });

  var itemPoint = pointOf(name);
  function leg(vid, a, b) {
    if (a === b) return { distanceM: 0, durationS: 0 };
    try {
      return getLeg_(date, P[a], P[b], vehById[vid].profile);
    } catch (e) {
      if (e.config) throw e;
      return { distanceM: Infinity, durationS: Infinity };
    }
  }

  var item = {
    point: itemPoint,
    weight: toNumber(row['화물중량(kg)'], 0),
    length: toNumber(row['화물최대길이(mm)'], 0),
    stayMin: cust.stayMin
  };
  var best = planPickupInsertion({
    item: item,
    vehicles: vehicles,
    legTime: function (vid, a, b) { return leg(vid, a, b).durationS / 60; },
    trips: trips,
    lastReturnByVehicle: lastReturnByVehicle,
    dayStart: s.dayStart, dayEnd: s.dayEnd, loadingMin: s.loadingMin,
    nowMin: toMinutes(nowTime_())
  });

  if (best.type === 'none') {
    updateRow_(todaySh, todayRowNum, { '경고': '운행 중 추가 불가: ' + best.reason });
    return { ok: false, message: name + ': 추가 불가 — ' + best.reason };
  }

  var vid = best.vehicleId;
  var km = function (a, b) { return leg(vid, a, b).distanceM / 1000; };
  var min = function (a, b) { return leg(vid, a, b).durationS / 60; };
  var tripsSh = getSheet_(SHEET.TRIPS);
  var logSh = getSheet_(SHEET.LOG);

  if (best.type === 'new') {
    var dist = km(0, itemPoint) + km(itemPoint, 0);
    appendRow_(tripsSh, {
      '일자': date, '차량ID': vid, '회차': best.trip,
      '출발예정': timeCell(formatMinutes(best.departMin)), '복귀예정': timeCell(formatMinutes(best.returnMin)),
      '방문수': 1, '총거리(km)': round1_(dist), '총소요(분)': Math.round(best.returnMin - best.departMin + s.loadingMin),
      '링크': buildTripLink_(date, vid, String(best.trip)), '상태': '계획'
    });
    createLogRows_(date, [{
      vehicleId: vid, trip: best.trip,
      legs: [{ name: name, distKm: km(0, itemPoint), kind: KIND_PICKUP }], returnDistKm: km(itemPoint, 0)
    }]);
    updateRow_(todaySh, todayRowNum, {
      '배정차량ID': vid, '회차': best.trip, '방문순서': 1,
      '예상도착시각': timeCell(formatMinutes(best.departMin + min(0, itemPoint))), '경고': ''
    });
    return {
      ok: true, type: 'new', vehicleId: vid, trip: best.trip,
      message: name + ': ' + vid + ' ' + best.trip + '회차(매입 전용, 새 회차)로 추가 — 새 링크를 기사에게 보내 주세요'
    };
  }

  // --- 기존 회차에 끼워 넣기 ---
  var t = trips.filter(function (x) { return x.vehicleId === vid && x.trip === Number(best.trip); })[0];
  var pos = best.position;
  var S = t.stops;
  var prevPt = pos === 0 ? 0 : S[pos - 1].point;
  var nextPt = pos < S.length ? S[pos].point : 0;
  var delta = best.deltaMin;

  // 1) 운행일지: 해당 자리 앞에 행 삽입, 다음 행의 구간거리 갱신
  var target = t.logs[pos]; // pos === S.length 이면 회사 복귀 행
  logSh.insertRowBefore(target._row);
  var vals = rowFromObj_(logSh, logRowObj_(date, vid, t.trip, name, km(prevPt, itemPoint), KIND_PICKUP));
  logSh.getRange(target._row, 1, 1, vals.length).setValues([vals]);
  var nextPatch = { '구간거리(API,km)': round1_(km(itemPoint, nextPt)) };
  if (nextPt === 0 && target['출발시각'] !== '') {
    // 회사로 복귀하던 중: 복귀 출발 기록을 지우고 매입처부터 다시 진행
    nextPatch['출발시각'] = '';
    nextPatch['도착시각'] = '';
  }
  updateRow_(logSh, target._row + 1, nextPatch);

  // 2) 오늘배송: 뒤 경유지 방문순서 +1, 예상도착 +delta, 새 행 배정
  var newEta;
  if (pos === 0) {
    newEta = toMinutes(t.tripRow['출발예정']) + min(0, itemPoint);
  } else {
    var prevPlan = t.plan[pos - 1];
    newEta = toMinutes(prevPlan['예상도착시각']) + S[pos - 1].stayMin + min(prevPt, itemPoint);
  }
  t.plan.forEach(function (pr, k) {
    if (k < pos) return;
    updateRow_(todaySh, pr._row, {
      '방문순서': Number(pr['방문순서']) + 1,
      '예상도착시각': shiftTime_(pr['예상도착시각'], delta)
    });
  });
  updateRow_(todaySh, todayRowNum, {
    '배정차량ID': vid, '회차': t.trip, '방문순서': pos + 1, '예상도착시각': timeCell(formatMinutes(newEta)), '경고': ''
  });

  // 3) 회차 탭: 이 회차 요약 갱신, 같은 차량의 뒤 회차는 delta만큼 밀기
  updateRow_(tripsSh, t.tripRow._row, {
    '방문수': Number(t.tripRow['방문수']) + 1,
    '복귀예정': shiftTime_(t.tripRow['복귀예정'], delta),
    '총소요(분)': Math.round(toNumber(t.tripRow['총소요(분)'], 0) + delta),
    '총거리(km)': round1_(toNumber(t.tripRow['총거리(km)'], 0) + km(prevPt, itemPoint) + km(itemPoint, nextPt) - km(prevPt, nextPt))
  });
  trips.forEach(function (o) {
    if (o.vehicleId !== vid || o.trip <= t.trip) return;
    updateRow_(tripsSh, o.tripRow._row, {
      '출발예정': shiftTime_(o.tripRow['출발예정'], delta),
      '복귀예정': shiftTime_(o.tripRow['복귀예정'], delta)
    });
    o.plan.forEach(function (pr) {
      updateRow_(todaySh, pr._row, { '예상도착시각': shiftTime_(pr['예상도착시각'], delta) });
    });
  });

  var after = pos === 0 ? '회사 출발 직후' : S[pos - 1].name + ' 다음';
  return {
    ok: true, type: 'insert', vehicleId: vid, trip: t.trip, position: pos,
    message: name + ': ' + vid + ' ' + t.trip + '회차 ' + after + '에 추가(+' + Math.round(delta) + '분) — 기존 링크 그대로, 기사 화면 자동 갱신'
  };
}

/** 시각 칸 값 + 분 → 'HH:MM' */
function shiftTime_(value, deltaMin) {
  var m = toMinutes(value);
  return m === null ? '' : timeCell(formatMinutes(m + deltaMin));
}
