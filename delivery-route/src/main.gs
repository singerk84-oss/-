/**
 * main.gs — 스프레드시트 메뉴와 전체 흐름(좌표 → 행렬 → 배차·경로 → 운행일지·링크)
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('배송관리')
    .addItem('① 시트 템플릿 확인', 'menuCheckTemplate')
    .addItem('② 주소 → 좌표 변환', 'menuGeocode')
    .addItem('③ 배차·경로 계산', 'menuPlan')
    .addItem('④ 회차 링크 전송', 'menuSend')
    .addSeparator()
    .addItem('회차 경유지 새로고침', 'menuSyncWaypoints')
    .addItem('링크 다시 만들기', 'menuLinks')
    .addItem('카카오 로그인(나에게 보내기 권한)', 'menuKakaoLogin')
    .addItem('예시 데이터 넣기(시험용)', 'menuSample')
    .addToUi();
}

function alert_(msg) {
  SpreadsheetApp.getUi().alert(msg);
}

function menuCheckTemplate() {
  var p = checkTemplate_();
  alert_(p.length ? '확인 결과\n- ' + p.join('\n- ') : '시트 템플릿 이상 없음. 보조 시트(회차·구간캐시·오류로그)도 준비했습니다.');
}

function menuGeocode() {
  var r = geocodeAll();
  alert_('좌표 변환 ' + r.done + '건 완료' + (r.failed.length ? '\n실패(주소 확인 필요):\n- ' + r.failed.join('\n- ') : ''));
}

function menuPlan() {
  var date = todayKey_();
  if (hasStartedLogs_(date)) {
    alert_('오늘 운행이 이미 시작되어 재계산할 수 없습니다.\n변경이 필요하면 운행일지의 해당 일자 기록을 정리한 뒤 다시 실행하세요.');
    return;
  }
  var r = planDay(date);
  var lines = r.trips.map(function (t) {
    return t.vehicleId + ' ' + t.trip + '회차: ' + formatMinutes(t.departMin) + ' 출발 → ' +
      formatMinutes(t.returnMin) + ' 복귀 (' + t.order.length + '곳)';
  });
  alert_('회차 ' + r.trips.length + '개, 링크 ' + r.links + '개 생성\n\n' + lines.join('\n') +
    (r.warnings.length ? '\n\n경고\n- ' + r.warnings.join('\n- ') : ''));
}

function menuSyncWaypoints() {
  var n = syncTripWaypoints_(todayKey_());
  alert_('회차 ' + n + '개의 경유지 표시를 새로 고쳤습니다. 완료된 경유지는 녹색입니다.');
}

function menuLinks() {
  alert_('링크 ' + generateLinks(todayKey_()) + '개를 다시 만들었습니다.');
}

function menuSend() {
  var r = sendTripLinks(todayKey_());
  alert_(r.sent + '개 회차 링크를 전송했습니다(' + r.mode + ').');
}

function menuKakaoLogin() {
  var url = kakaoAuthorizeUrl_();
  var html = HtmlService.createHtmlOutput(
    '<p>아래 링크를 열어 카카오 로그인 후 동의하면 나에게 보내기 권한이 저장됩니다.</p>' +
    '<p><a href="' + url + '" target="_blank">카카오 로그인 열기</a></p>' +
    '<p style="color:#666;font-size:12px">카카오 디벨로퍼스 [카카오 로그인 > Redirect URI]에 웹앱 URL을 등록해야 합니다.</p>'
  ).setWidth(420).setHeight(160);
  SpreadsheetApp.getUi().showModalDialog(html, '카카오 로그인');
}

/**
 * 하루치 배차·경로 계산 전체 흐름
 * @return {{trips:Object[], warnings:string[], links:number}}
 */
function planDay(date) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return planDayLocked_(date);
  } finally {
    lock.releaseLock();
  }
}

function planDayLocked_(date) {
  try {
    pruneLegCache_(date);
  } catch (e) {
    logError_('구간캐시정리', e && e.message ? e.message : e);
  }
  var s = readSettings_();
  if (s.companyLat === null || s.companyLng === null) {
    if (!s.companyAddress) throw new Error('설정 시트에 회사주소를 입력하세요.');
    geocodeAll();
    s = readSettings_();
    if (s.companyLat === null) throw new Error('회사 주소의 좌표를 찾지 못했습니다. 주소를 확인하세요.');
  }

  // 거래처
  var customers = {};
  readTable_(SHEET.CUSTOMERS).forEach(function (r) {
    customers[String(r['거래처명']).trim()] = {
      name: String(r['거래처명']).trim(),
      address: r['주소'],
      lat: toNumber(r['위도'], null),
      lng: toNumber(r['경도'], null),
      stayMin: toNumber(r['체류시간(분)'], s.defaultStayMin)
    };
  });

  // 차량
  var vehicles = readTable_(SHEET.VEHICLES).filter(function (r) { return r['차량ID'] !== ''; }).map(function (r) {
    return {
      id: String(r['차량ID']).trim(),
      maxWeight: toNumber(r['최대적재중량(kg)'], 0),
      bedLength: toNumber(r['적재함길이(mm)'], 0),
      profile: vehicleProfile_(r)
    };
  });
  if (!vehicles.length) throw new Error('차량 시트에 차량을 입력하세요.');
  var profileWarn = [];
  vehicles.forEach(function (v) { profileWarn = profileWarn.concat(profileWarnings_(v.id, v.profile)); });

  // 오늘배송: 일자가 비어 있으면 오늘로 채운다
  var todaySh = getSheet_(SHEET.TODAY);
  var all = readTable_(SHEET.TODAY);
  var rows = all.filter(function (r) {
    if (r['일자'] === '' && String(r['거래처명']).trim() !== '') {
      updateRow_(todaySh, r._row, { '일자': date });
      return true;
    }
    return dateKey_(r['일자']) === date;
  });
  if (!rows.length) throw new Error(date + ' 일자의 오늘배송 행이 없습니다.');

  // 지점: 0 = 회사, 이후 거래처(중복 제거)
  var points = [{ lat: s.companyLat, lng: s.companyLng }];
  var pointOf = {};
  var deliveries = [];
  var rowMap = [];
  var preWarn = {};
  rows.forEach(function (r) {
    var name = String(r['거래처명']).trim();
    var c = customers[name];
    if (!c) { preWarn[r._row] = '거래처 시트에 없는 거래처'; return; }
    if (c.lat === null || c.lng === null) { preWarn[r._row] = '거래처 좌표 없음(주소→좌표 변환 필요)'; return; }
    if (pointOf[name] === undefined) {
      pointOf[name] = points.length;
      points.push({ lat: c.lat, lng: c.lng });
    }
    deliveries.push({
      id: r._row,
      point: pointOf[name],
      weight: toNumber(r['화물중량(kg)'], 0),
      length: toNumber(r['화물최대길이(mm)'], 0),
      stayMin: c.stayMin,
      manual: toBool(r['수동지정']),
      vehicleId: String(r['배정차량ID'] || '').trim(),
      trip: toNumber(r['회차'], '')
    });
    rowMap.push({ row: r._row, name: name });
  });

  // 차량별 행렬(화물차는 차량마다 지날 수 있는 길이 다르다)
  var mats = buildVehicleMatrices(date, points, vehicles);
  var timeByVehicle = {};
  vehicles.forEach(function (v) { timeByVehicle[v.id] = mats[v.id].time; });
  var plan = planDeliveries({
    deliveries: deliveries,
    vehicles: vehicles,
    time: mats[vehicles[0].id].time,
    timeByVehicle: timeByVehicle,
    dayStart: s.dayStart,
    dayEnd: s.dayEnd,
    loadingMin: s.loadingMin
  });

  // 오늘배송 결과 쓰기
  var byRow = {};
  plan.rows.forEach(function (r) { byRow[r.id] = r; });
  rows.forEach(function (r) {
    var p = byRow[r._row];
    var patch = p ? {
      '배정차량ID': p.vehicleId,
      '회차': p.trip,
      '방문순서': p.seq,
      '예상도착시각': p.etaMin === null ? '' : formatMinutes(p.etaMin),
      '경고': p.warnings.join(' / ')
    } : { '배정차량ID': '', '회차': '', '방문순서': '', '예상도착시각': '', '경고': preWarn[r._row] || '' };
    updateRow_(todaySh, r._row, patch);
  });

  // 회차 시트·운행일지 다시 만들기
  getSheet_(SHEET.TRIPS, HEADERS.TRIPS);
  clearDayRows_(SHEET.TRIPS, date);
  clearDayRows_(SHEET.LOG, date);

  var nameOfRow = {};
  rowMap.forEach(function (x) { nameOfRow[x.row] = x.name; });
  var pointOfRow = {};
  deliveries.forEach(function (d) { pointOfRow[d.id] = d.point; });

  var tripsSh = getSheet_(SHEET.TRIPS);
  var legsByTrip = [];
  plan.trips.forEach(function (t) {
    var m = mats[t.vehicleId];
    var prev = 0;
    var legs = [];
    var total = 0;
    t.order.forEach(function (rowId) {
      var p = pointOfRow[rowId];
      legs.push({ name: nameOfRow[rowId], distKm: m.dist[prev][p] });
      total += m.dist[prev][p];
      prev = p;
    });
    var back = m.dist[prev][0];
    total += back;
    legsByTrip.push({ vehicleId: t.vehicleId, trip: t.trip, legs: legs, returnDistKm: back });
    appendRow_(tripsSh, {
      '일자': date, '차량ID': t.vehicleId, '회차': t.trip,
      '출발예정': formatMinutes(t.departMin), '복귀예정': formatMinutes(t.returnMin),
      '방문수': t.order.length, '총거리(km)': round1_(total), '총소요(분)': Math.round(t.totalMin),
      '상태': t.warnings.length ? '경고' : '계획'
    });
  });
  createLogRows_(date, legsByTrip);
  safeSyncTripWaypoints_(date);

  var links = 0;
  try {
    links = generateLinks(date);
  } catch (e) {
    plan.warnings.push('링크 생성 실패: ' + e.message);
  }
  Object.keys(preWarn).forEach(function (row) { plan.warnings.push(row + '행: ' + preWarn[row]); });
  plan.warnings = plan.warnings.concat(profileWarn);
  var failedLegs = 0;
  Object.keys(mats).forEach(function (k) { failedLegs = Math.max(failedLegs, mats[k].failed.length); });
  if (failedLegs) plan.warnings.push('경로를 찾지 못한 구간 ' + failedLegs + '개(진입 불가로 처리, 오류로그 확인)');
  return { trips: plan.trips, warnings: plan.warnings, links: links };
}

/**
 * 시험용 예시 데이터(1톤 2회, 5톤 3회, 10톤 1회가 나오도록 구성).
 * 회사 좌표를 기준으로 가상의 거래처 좌표를 만든다. ROUTE_PROVIDER=estimate 에서 확인용.
 */
function menuSample() {
  var s = readSettings_();
  if (s.companyLat === null || s.companyLng === null) {
    alert_('먼저 설정 시트에 회사주소를 넣고 [② 주소 → 좌표 변환]을 실행하세요.');
    return;
  }
  var kmLat = 1 / 111;
  var kmLng = 1 / (111 * Math.cos(s.companyLat * Math.PI / 180));
  // [이름, 동쪽km, 북쪽km, 중량kg, 길이mm]
  var sample = [
    ['예시-원거리공장', 123, 0, 9500, 8000],
    ['예시-북부창고', 0, 33, 4500, 4000],
    ['예시-서부물류', -33, 0, 4500, 4000],
    ['예시-남부상사', 0, -33, 4500, 4000],
    ['예시-근거리A', 5, 5, 800, 2000],
    ['예시-근거리B', -5, 5, 800, 2000]
  ];
  var cust = getSheet_(SHEET.CUSTOMERS);
  var today = getSheet_(SHEET.TODAY);
  var date = todayKey_();
  sample.forEach(function (x) {
    appendRow_(cust, {
      '거래처명': x[0], '주소': '(예시 좌표)',
      '위도': Math.round((s.companyLat + x[2] * kmLat) * 1e6) / 1e6,
      '경도': Math.round((s.companyLng + x[1] * kmLng) * 1e6) / 1e6,
      '체류시간(분)': 30
    });
    appendRow_(today, { '일자': date, '거래처명': x[0], '화물중량(kg)': x[3], '화물최대길이(mm)': x[4], '수동지정': false });
  });
  checkTemplate_(); // 차량 시트에 화물차 제원 컬럼이 없으면 추가
  var veh = getSheet_(SHEET.VEHICLES);
  if (readTable_(SHEET.VEHICLES).length === 0) {
    // 제원은 대략적인 예시값이다. 실제 차량등록증·제원표 값으로 바꿔 넣는다. TMAP차종은 공식 코드표 확인 후 입력.
    [['V1', '1톤 예시', '1톤', 1000, 2800, 200, 175, 510, 3000],
     ['V5', '5톤 예시', '5톤', 5000, 6200, 300, 249, 900, 11500],
     ['V10', '10톤 예시', '10톤', 10000, 9100, 350, 249, 1150, 20000]].forEach(function (r) {
      appendRow_(veh, {
        '차량ID': r[0], '차량명': r[1], '톤수': r[2], '최대적재중량(kg)': r[3], '적재함길이(mm)': r[4],
        '차량높이(cm)': r[5], '차량폭(cm)': r[6], '차량길이(cm)': r[7], '차량총중량(kg)': r[8]
      });
    });
  }
  alert_('예시 데이터를 넣었습니다. 스크립트 속성 ROUTE_PROVIDER=estimate 로 두고 [③ 배차·경로 계산]을 실행하세요.');
}
