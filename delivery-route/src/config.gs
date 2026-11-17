/**
 * config.gs — 시트명, 컬럼 정의, 기본값, 스크립트 속성 키
 *
 * API 키 등 비밀값은 코드에 쓰지 않고 [프로젝트 설정 > 스크립트 속성]에 저장한다.
 *   KAKAO_REST_KEY      : 카카오 REST API 키(로컬 API·모빌리티 길찾기 공용)
 *   KAKAO_REFRESH_TOKEN : 나에게 보내기용 사용자 리프레시 토큰(선택)
 *   KAKAO_CLIENT_SECRET : 카카오 앱 클라이언트 시크릿(사용 설정한 경우만)
 *   LINK_SECRET         : 웹앱 링크 서명 비밀값(없으면 최초 실행 시 자동 생성)
 *   SPREADSHEET_ID      : 웹앱이 사용할 스프레드시트 ID(없으면 연결된 시트 사용)
 *   NOTIFY_MODE         : 'kakao_memo' | 'email'(기본) | 'alimtalk'(2단계)
 *   NOTIFY_EMAIL        : 이메일 전송 대상(없으면 스크립트 소유자)
 *   TMAP_APP_KEY        : SK오픈API TMAP 앱 키(화물차 경로안내)
 *   ROUTE_PROVIDER      : 'tmap'(기본, 화물차 경로) | 'kakao'(승용차 경로) | 'estimate'(API 없이 직선거리 추정, 시험용)
 *   DISTANCE_MODE       : (이전 설정) 'estimate'이면 ROUTE_PROVIDER=estimate 와 같다
 */

var SHEET = {
  SETTINGS: '설정',
  CUSTOMERS: '거래처',
  VEHICLES: '차량',
  TODAY: '오늘배송',
  LOG: '운행일지',
  CLOSE: '일일마감',
  // 아래 시트는 시스템이 자동 생성한다.
  TRIPS: '회차',
  LEG_CACHE: '구간캐시',
  ERROR_LOG: '오류로그'
};

/** 각 시트의 헤더(1행). 순서가 곧 컬럼 순서다. */
var HEADERS = {
  CUSTOMERS: ['거래처명', '주소', '위도', '경도', '체류시간(분)'],
  VEHICLES: ['차량ID', '차량명', '차량번호', '톤수', '최대적재중량(kg)', '적재함길이(mm)', '기사명', '기사휴대폰',
    '차량높이(cm)', '차량폭(cm)', '차량길이(cm)', '차량총중량(kg)', 'TMAP차종'],
  TODAY: ['일자', '거래처명', '화물중량(kg)', '화물최대길이(mm)', '배정차량ID', '회차', '방문순서', '예상도착시각', '수동지정', '경고'],
  LOG: ['일자', '차량ID', '회차', '거래처명', '출발시각', '도착시각', '완료시각', '구간거리(API,km)'],
  CLOSE: ['일자', '차량ID', '계기판주행거리(km)', '전일대비실주행(km)', 'API합산거리(km)', '차이(km)'],
  TRIPS: ['일자', '차량ID', '회차', '출발예정', '복귀예정', '방문수', '총거리(km)', '총소요(분)', '링크', '전송시각', '상태'],
  LEG_CACHE: ['일자', '차량프로필', '출발좌표', '도착좌표', '거리(m)', '시간(초)', '출처'],
  ERROR_LOG: ['시각', '구분', '내용']
};

/** 설정 시트 항목명 → 내부 키 */
var SETTING_KEYS = {
  '회사주소': 'companyAddress',
  '회사위도': 'companyLat',
  '회사경도': 'companyLng',
  '운행시작': 'dayStart',
  '운행종료': 'dayEnd',
  '상차시간(분)': 'loadingMin',
  '기본체류시간(분)': 'defaultStayMin'
};

var DEFAULTS = {
  dayStart: '08:00',
  dayEnd: '18:00',
  loadingMin: 30,
  defaultStayMin: 30
};

/** 운행일지에서 회사 복귀 구간을 나타내는 거래처명 */
var RETURN_LABEL = '회사 복귀';

/** 전수 탐색을 허용하는 최대 배송지 수(초과 시 최근접 이웃 + 2-opt) */
var EXACT_ROUTE_LIMIT = 8;

/** API 재시도 횟수와 대기(ms) */
var API_RETRY = 3;
var API_RETRY_WAIT_MS = 800;

/** 직선거리 추정 모드 계수(시험용): 도로 우회 계수와 평균 속도 */
var ESTIMATE_ROAD_FACTOR = 1.3;
var ESTIMATE_SPEED_KMH = 40;

/** 시트 템플릿에 없어도 되는(없으면 자동으로 추가하는) 컬럼 */
var OPTIONAL_HEADERS = {
  '차량': ['차량높이(cm)', '차량폭(cm)', '차량길이(cm)', '차량총중량(kg)', 'TMAP차종']
};

/** 경로 제공자: tmap | kakao | estimate */
function routeProvider_() {
  if (getProp_('DISTANCE_MODE') === 'estimate') return 'estimate';
  return getProp_('ROUTE_PROVIDER') || 'tmap';
}

/**
 * 비밀이 아닌 설정은 설정 시트에서도 읽는다(스크립트 속성이 우선).
 * API 키·토큰 같은 비밀값은 스크립트 속성에만 둔다.
 */
var SHEET_CONFIG = {
  WEBAPP_URL: '웹앱URL',
  ROUTE_PROVIDER: '경로제공자',
  NOTIFY_MODE: '전송방식',
  NOTIFY_EMAIL: '전송이메일',
  LEG_CACHE_KEEP_DAYS: '구간캐시보관일수'
};
var sheetConfigMemo_ = null;

function getProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v || !SHEET_CONFIG[key]) return v;
  if (!sheetConfigMemo_) {
    sheetConfigMemo_ = {};
    try {
      var sh = getSpreadsheet_().getSheetByName(SHEET.SETTINGS);
      if (sh && sh.getLastRow() > 0) {
        sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(function (r) {
          sheetConfigMemo_[String(r[0]).trim()] = String(r[1]).trim();
        });
      }
    } catch (e) {
      // 시트를 못 읽으면 스크립트 속성만 쓴다
    }
  }
  return sheetConfigMemo_[SHEET_CONFIG[key]] || null;
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}
