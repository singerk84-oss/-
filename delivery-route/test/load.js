// Apps Script(.gs) 파일을 Node vm 컨텍스트에 불러와 순수 함수를 시험한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGs(files) {
  const ctx = vm.createContext({ console, Math, Date, JSON, Object, Array, Number, String, Error, isNaN });
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return ctx;
}

module.exports = { loadGs };
