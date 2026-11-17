// Apps Script 서비스의 최소 메모리 모의 객체(통합 시험용)
const crypto = require('crypto');

class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    vals.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  clearContent() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet.set(this.row + r, this.col + c, '');
    return this;
  }
  setFontWeight() { return this; }
  setBackgrounds(m) { m.forEach((line, r) => line.forEach((v, c) => this.sheet.setBg(this.row + r, this.col + c, v))); return this; }
  setBackground(v) { this.sheet.setBg(this.row, this.col, v); return this; }
  setFontColors() { return this; }
  setFontColor() { return this; }
  insertCheckboxes() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.bg = {}; }
  setBg(r, c, v) { this.bg[r + ',' + c] = v; }
  getName() { return this.name; }
  set(r, c, v) {
    if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1); // 시트처럼 ' 접두는 글자 표시로만 쓰임
    while (this.data.length < r) this.data.push([]);
    this.data[r - 1][c - 1] = v;
  }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) {
      if ((this.data[r - 1] || []).some((v) => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }
  getLastColumn() { return this.data.reduce((m, row) => Math.max(m, row.length), 0); }
  getMaxRows() { return Math.max(this.data.length, 100); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, c) => this.set(r, c + 1, v)); }
  insertRowBefore(r) {
    this.data.splice(r - 1, 0, []);
    const nb = {};
    for (const [k, v] of Object.entries(this.bg)) {
      const [rr, cc] = k.split(',').map(Number);
      nb[(rr >= r ? rr + 1 : rr) + ',' + cc] = v;
    }
    this.bg = nb;
  }
  deleteRow(r) {
    this.data.splice(r - 1, 1);
    const nb = {};
    for (const [k, v] of Object.entries(this.bg)) {
      const [rr, cc] = k.split(',').map(Number);
      if (rr < r) nb[k] = v; else if (rr > r) nb[(rr - 1) + ',' + cc] = v;
    }
    this.bg = nb;
  }
  setFrozenRows() {}
}

function createGas({ props = {}, now = new Date('2026-11-16T08:00:00+09:00') } = {}) {
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n))
  };
  const store = Object.assign({}, props);
  const clock = { now };
  const fmtParts = (d) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(d);
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock.now.getTime()); }
    static now() { return clock.now.getTime(); }
  }
  const mails = [];
  const ctx = {
    console, Math, JSON, Object, Array, Number, String, Error, isNaN, isFinite, Infinity, encodeURIComponent,
    Date: FakeDate,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); }
      })
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Seoul',
      getEffectiveUser: () => ({ getEmail: () => 'manager@example.com' })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    UrlFetchApp: { fetch: () => { throw new Error('시험 중 외부 호출 금지'); } },
    Utilities: {
      Charset: { UTF_8: 'utf8' },
      formatDate: (d, tz, fmt) => {
        const p = fmtParts(d);
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
      computeHmacSha256Signature: (msg, key) => [...crypto.createHmac('sha256', key).update(msg).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      getUuid: () => crypto.randomUUID(),
      sleep: () => {}
    }
  };
  return { ctx, sheets, ss, store, clock, mails, Sheet };
}

module.exports = { createGas };
