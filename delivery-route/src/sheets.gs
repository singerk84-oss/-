/**
 * sheets.gs — 시트 읽기·쓰기 공통 함수
 */

function getSpreadsheet_() {
  var id = getProp_('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트를 찾을 수 없습니다. 스크립트 속성 SPREADSHEET_ID를 설정하세요.');
  return ss;
}

/** 시트를 가져온다. 없고 headers가 있으면 만들고 헤더를 쓴다. */
function getSheet_(name, headers) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    if (!headers) throw new Error('시트가 없습니다: ' + name);
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 헤더 → 컬럼 번호(1부터) */
function headerIndex_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  head.forEach(function (h, i) { if (h !== '') idx[String(h).trim()] = i + 1; });
  return idx;
}

/** 표 전체를 객체 배열로 읽는다. 각 객체에 _row(시트 행 번호)를 넣는다. */
function readTable_(name, headers) {
  var sh = getSheet_(name, headers);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    var obj = { _row: r + 1 };
    head.forEach(function (h, c) { if (h) obj[h] = row[c]; });
    out.push(obj);
  }
  return out;
}

/** 한 행의 특정 컬럼들만 갱신 {헤더: 값} */
function updateRow_(sh, rowNum, patch) {
  var idx = headerIndex_(sh);
  Object.keys(patch).forEach(function (h) {
    if (!idx[h]) throw new Error(sh.getName() + ' 시트에 컬럼이 없습니다: ' + h);
    sh.getRange(rowNum, idx[h]).setValue(patch[h]);
  });
}

/** 헤더 순서대로 객체를 행으로 추가 */
function appendRow_(sh, obj) {
  var idx = headerIndex_(sh);
  var width = sh.getLastColumn();
  var row = [];
  for (var c = 0; c < width; c++) row.push('');
  Object.keys(obj).forEach(function (h) { if (idx[h]) row[idx[h] - 1] = obj[h]; });
  sh.appendRow(row);
}

/** 날짜 셀 → 'yyyy-MM-dd' */
function dateKey_(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(value).trim().replace(/[./]/g, '-');
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s;
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function nowTime_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/** 설정 시트를 읽어 내부 키 객체로 */
function readSettings_() {
  var sh = getSheet_(SHEET.SETTINGS);
  var values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  var s = {};
  values.forEach(function (r) {
    var key = SETTING_KEYS[String(r[0]).trim()];
    if (key) s[key] = r[1];
  });
  return {
    companyAddress: String(s.companyAddress || '').trim(),
    companyLat: toNumber(s.companyLat, null),
    companyLng: toNumber(s.companyLng, null),
    dayStart: toMinutes(s.dayStart || DEFAULTS.dayStart),
    dayEnd: toMinutes(s.dayEnd || DEFAULTS.dayEnd),
    loadingMin: toNumber(s.loadingMin, DEFAULTS.loadingMin),
    defaultStayMin: toNumber(s.defaultStayMin, DEFAULTS.defaultStayMin)
  };
}

/** 설정 시트의 특정 항목 값을 쓴다 */
function writeSetting_(label, value) {
  var sh = getSheet_(SHEET.SETTINGS);
  var values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim() === label) {
      sh.getRange(r + 1, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([label, value, '']);
}

/** 오류로그 시트에 기록(기록 자체가 실패해도 본 작업은 멈추지 않는다) */
function logError_(kind, message) {
  try {
    var sh = getSheet_(SHEET.ERROR_LOG, HEADERS.ERROR_LOG);
    sh.appendRow([nowStamp_(), kind, String(message).slice(0, 2000)]);
  } catch (e) {
    console.error('오류로그 기록 실패: ' + e);
  }
}

/** 시트 템플릿 확인: 필수 시트·헤더 점검, 보조 시트 생성 */
function checkTemplate_() {
  var problems = [];
  var required = [
    [SHEET.CUSTOMERS, HEADERS.CUSTOMERS], [SHEET.VEHICLES, HEADERS.VEHICLES],
    [SHEET.TODAY, HEADERS.TODAY], [SHEET.LOG, HEADERS.LOG], [SHEET.CLOSE, HEADERS.CLOSE]
  ];
  var ss = getSpreadsheet_();
  if (!ss.getSheetByName(SHEET.SETTINGS)) problems.push('설정 시트 없음');
  required.forEach(function (pair) {
    var sh = ss.getSheetByName(pair[0]);
    if (!sh) {
      getSheet_(pair[0], pair[1]);
      problems.push(pair[0] + ' 시트를 새로 만들었습니다');
      return;
    }
    var idx = headerIndex_(sh);
    var optional = OPTIONAL_HEADERS[pair[0]] || [];
    var added = optional.filter(function (h) { return !idx[h]; });
    if (added.length) {
      sh.getRange(1, sh.getLastColumn() + 1, 1, added.length).setValues([added]).setFontWeight('bold');
      problems.push(pair[0] + ' 시트에 컬럼 추가: ' + added.join(', '));
      idx = headerIndex_(sh);
    }
    var missing = pair[1].filter(function (h) { return !idx[h]; });
    if (missing.length) problems.push(pair[0] + ' 시트 컬럼 누락: ' + missing.join(', '));
  });
  getSheet_(SHEET.TRIPS, HEADERS.TRIPS);
  getSheet_(SHEET.LEG_CACHE, HEADERS.LEG_CACHE);
  getSheet_(SHEET.ERROR_LOG, HEADERS.ERROR_LOG);
  // 수동지정 칸을 체크박스로
  var today = ss.getSheetByName(SHEET.TODAY);
  var col = headerIndex_(today)['수동지정'];
  if (col) today.getRange(2, col, Math.max(today.getMaxRows() - 1, 1), 1).insertCheckboxes();
  return problems;
}
