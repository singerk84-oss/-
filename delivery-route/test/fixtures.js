// 시험용 예시 데이터: 평면 좌표(km)와 시속 60km(1km = 1분) 가정
const VEHICLES = [
  { id: 'V1', maxWeight: 1000, bedLength: 2800 },   // 1톤
  { id: 'V5', maxWeight: 5000, bedLength: 6200 },   // 5톤
  { id: 'V10', maxWeight: 10000, bedLength: 9100 }  // 10톤
];

// [이름, x, y, 중량kg, 길이mm]
const SAMPLE = [
  ['원거리공장', 240, 0, 9500, 8000],  // 10톤만 가능, 장거리 1회
  ['북부창고', 0, 65, 4500, 4000],     // 5톤 이상
  ['서부물류', -65, 0, 4500, 4000],
  ['남부상사', 0, -65, 4500, 4000],
  ['근거리A', 10, 10, 800, 2000],      // 1톤 가능
  ['근거리B', -10, 10, 800, 2000]
];

function buildInput(list, opts = {}) {
  const pts = [[0, 0]].concat(list.map((r) => [r[1], r[2]]));
  const time = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
  return {
    deliveries: list.map((r, i) => Object.assign({
      id: r[0], point: i + 1, weight: r[3], length: r[4], stayMin: 30,
      manual: false, vehicleId: '', trip: ''
    }, (opts.overrides || {})[r[0]] || {})),
    vehicles: opts.vehicles || VEHICLES,
    time,
    dayStart: 480,
    dayEnd: 1080,
    loadingMin: 30
  };
}

module.exports = { VEHICLES, SAMPLE, buildInput };
