/* ============================================================
 * BM 현황 — 단계 판정 엔진
 * 입력: 현장 행(row) + 그 현장의 세부공정 행(stages)
 * 출력: 트랙(공장/현장), 현재 단계, 단계별 상태, 입금, 그룹 상태, 날짜
 * 순수 함수만 — DOM 의존 없음 (브라우저·n8n Code 노드 공용 가능)
 * ============================================================ */
(function (root) {
  'use strict';

  // ---------- 상태 분류 ----------
  const DONE_KW    = ['완료', 'done', '승인', '납품'];
  const SKIP_KW    = ['진행 안함', '진행안함', "won't do", 'wont do'];
  const ACTIVE_KW  = ['시공 중', '시공중', '진행 중', '진행중', 'in progress', '접수'];

  const lower = s => String(s || '').toLowerCase();
  const isDone    = s => DONE_KW.some(k => lower(s).includes(k));
  const isSkipped = s => SKIP_KW.some(k => lower(s).includes(k));
  const isActive  = s => !isDone(s) && ACTIVE_KW.some(k => lower(s).includes(k));

  // 묶음 규칙: 하나라도 진행(또는 일부 완료) → now, 전부 완료 → done, 없음 → null
  function groupStatus(items) {
    const live = items.filter(i => !isSkipped(i.state));
    if (!live.length) return null;
    const done = live.filter(i => isDone(i.state)).length;
    if (done === live.length) return 'done';
    if (done > 0 || live.some(i => isActive(i.state))) return 'now';
    return 'wait';
  }

  // ---------- 항목 이름 정리 ----------
  function stripSite(name, issueName) {
    const n = String(name || '');
    if (issueName && n.startsWith(issueName + '-')) return n.slice(issueName.length + 1);
    return n.replace(/^[^-]*-/, '');
  }

  function pick(stages, process, keywords, issueName) {
    return stages
      .filter(s => s.PROCESS === process)
      .map(s => ({ name: stripSite(s['STAGE NAME'], issueName), state: s.STATE || '', seq: +s.SEQ || 0 }))
      .filter(i => !keywords || keywords.some(k => i.name.includes(k)))
      .sort((a, b) => a.seq - b.seq);
  }

  // AD 묶음 키워드 (구형·신형 템플릿 동시 대응)
  const KW = {
    design:    ['법규검토', '법규 검토', '기본계획', '기본설계', '실시도면', '실시설계'],
    shimDo:    ['실시도면', '실시설계'],
    interior:  ['인테리어 상담', '인테리어 산출물'],
    change:    ['변경계약'],
    drawings:  ['생산도면', '도면검토', '골조도', '조립도', '재단표', '기초도면'],
    permit:    ['인허가'],
  };

  // ---------- 입금 ----------
  const PAY_PLAN = [
    { key: 'deposit', label: '계약금', ratio: 0.10, threshold: 5 },
    { key: 'interim', label: '중도금', ratio: 0.80, threshold: 85 },
    { key: 'final',   label: '잔금',   ratio: 0.10, threshold: 99 },
  ];

  function num(v) { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }

  function payment(row) {
    const total = num(row['공사비_총액']);
    const paid  = num(row['공사비_수금액']);
    const pct   = num(row['공사비_수금율']);
    let cum = 0;
    const items = PAY_PLAN.map(p => {
      const planned = Math.round(total * p.ratio);
      const prevCum = cum; cum += planned;
      let status = 'wait';
      if (pct >= p.threshold) status = 'done';
      else if (paid > prevCum) status = 'partial';
      const paidHere = status === 'done' ? planned : Math.max(0, Math.min(planned, paid - prevCum));
      return { ...p, planned, paidHere, status };
    });
    const current = items.find(i => i.status !== 'done') || null;
    return {
      total, paid, pct, items, current,
      design: {
        total: num(row['설계비_총액']), paid: num(row['설계비_수금액']), pct: num(row['설계비_수금율']),
        done: num(row['설계비_수금율']) >= 99 || (num(row['설계비_총액']) > 0 && num(row['설계비_수금액']) >= num(row['설계비_총액'])),
      },
    };
  }

  // ---------- 단계 정의 ----------
  const FACTORY_STAGES = [
    { id: 'contract', title: '계약 완료' },
    { id: 'design',   title: '설계 중' },
    { id: 'interior', title: '인테리어 · 변경계약' },
    { id: 'interim',  title: '중도금 납부' },
    { id: 'drawings', title: '제작 도면' },
    { id: 'factory',  title: '공장 생산' },
    { id: 'final',    title: '잔금 납부' },
    { id: 'install',  title: '상차 · 설치' },
  ];
  const SITE_STAGES = [
    ...FACTORY_STAGES.slice(0, 5),
    { id: 'sitebuild', title: '현장 시공' },
    { id: 'complete',  title: '잔금 · 준공' },
  ];

  function parseDate(s) { if (!s) return null; const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? null : d; }

  // ---------- 메인 ----------
  function compute(row, stages, today) {
    today = today || new Date();
    const issueName = row['ISSUE NAME'] || '';
    const track = /현장/.test(String(row['제작처'] || '')) ? 'site' : 'factory';
    const bmState = String(row['BM STATE'] || '');

    const g = {
      design:   pick(stages, 'AD', KW.design, issueName),
      shimDo:   pick(stages, 'AD', KW.shimDo, issueName),
      interior: pick(stages, 'AD', KW.interior, issueName),
      change:   pick(stages, 'AD', KW.change, issueName),
      drawings: pick(stages, 'AD', KW.drawings, issueName),
      permit:   pick(stages, 'AD', KW.permit, issueName),
      fc:       pick(stages, 'FC', null, issueName),
      ios:      pick(stages, 'IOS', null, issueName),
      cos:      pick(stages, 'COS', null, issueName),
      ofb:      pick(stages, 'OFB', null, issueName),
      asos:     pick(stages, 'ASOS', null, issueName),
    };
    // 현장제작(COS): 청구/준공서류는 사무 항목 → 시공 완료 판정·공정률에서 제외
    g.cosBuild = g.cos.filter(i => !/청구|준공서류/.test(i.name));
    g.cosAdmin = g.cos.filter(i =>  /청구|준공서류/.test(i.name));
    const gs = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, groupStatus(v)]));
    const pay = payment(row);
    const dates = {
      contract: row['계약일'] || '', shipping: row['상차일'] || '',
      start: row['착공일'] || '', movein: row['희망입주일'] || '',
    };
    const shipDate = parseDate(dates.shipping);
    const started = s => s === 'now' || s === 'done';

    const defs = track === 'site' ? SITE_STAGES : FACTORY_STAGES;
    const idx = id => defs.findIndex(d => d.id === id);
    let cur = 0;

    // 공통 전반부 (1~5): 계약 → 설계 → 인테리어·변경계약 → 중도금 → 제작 도면
    // 변경계약 중에도 인테리어 상담이 오가므로 한 단계로 묶음. 변경계약 완료(또는 BM 착공대기)면 중도금 단계
    const changeDone = gs.change === 'done' || /착공대기|착공|설치시공/.test(bmState);
    const earlyStage = () => {
      if (pay.pct >= 85)                                                    return idx('drawings');
      if (changeDone)                                                       return idx('interim');
      if (gs.shimDo === 'done' || /변경계약/.test(bmState))                  return idx('interior');
      if (started(gs.design) || /설계대기|설계진행/.test(bmState))          return idx('design');
      return idx('contract');
    };

    if (track === 'factory') {
      if (pay.pct >= 99 && (started(gs.ios) || (shipDate && shipDate <= today)))      cur = idx('install');
      else if (gs.fc === 'done' && pay.pct < 99)                                        cur = idx('final');
      else if (gs.fc === 'done')                                                        cur = idx('install');   // 제작 끝·잔금 완료, 상차 기록만 아직 없음 → 상차·설치
      else if (started(gs.fc))                                                          cur = idx('factory');
      else                                                                              cur = earlyStage();
    } else {
      if (gs.cosBuild === 'done')                                                       cur = idx('complete');
      else if (started(gs.cosBuild))                                                    cur = idx('sitebuild');
      else                                                                              cur = earlyStage();
    }

    // 단계별 실제 완료 여부 — 현재 단계와 무관하게 자기 항목의 상태로 평가
    // (단계를 건너뛴 현장: 공장 생산 중인데 변경계약 미완 등) → done / partial / unknown
    const pseudo = (name, ok, waitLabel) => ({ name, state: ok ? '완료' : (waitLabel || '대기'), seq: 0 });
    const live = arr => arr.filter(i => !isSkipped(i.state));
    const evalItems = items => {
      if (!items.length) return 'unknown';
      return items.every(i => isDone(i.state)) ? 'done' : 'partial';
    };
    const evalStage = id => {
      let items = [];
      switch (id) {
        case 'contract':
          items = [pseudo('계약금 10%', pay.items[0].status === 'done', '미납')];
          if (pay.design.total) items.push(pseudo('설계비 100%', pay.design.done, '미납'));
          break;
        case 'design':   items = live(g.design); break;
        case 'interior': {
          const consult = live(g.interior).filter(i => i.name.includes('상담'));
          const ch = live(g.change).length ? live(g.change) : [pseudo('변경계약서', changeDone, /변경계약/.test(bmState) ? '진행 중' : '대기')];
          items = [...consult, ...ch]; break;
        }
        case 'interim':  items = [pseudo('중도금 80%', pay.pct >= 85, '미납')]; break;
        case 'drawings': items = [...live(g.drawings), ...live(g.interior).filter(i => i.name.includes('산출물'))]; break;
        case 'factory':  items = live(g.fc); break;
        case 'final':    items = [pseudo('잔금 10%', pay.pct >= 99, '미납')]; break;
        case 'install':  items = live(g.ios); break;
        case 'sitebuild': items = live(g.cosBuild); break;
        case 'complete': items = [pseudo('잔금 10%', pay.pct >= 99, '미납'), ...live(g.cosAdmin)]; break;
      }
      return { status: evalItems(items), items };
    };

    const stagesOut = defs.map((d, i) => ({
      ...d, index: i,
      status: i < cur ? 'done' : i === cur ? 'now' : 'wait',
      check: i < cur ? evalStage(d.id) : null,
    }));

    return {
      track, bmState, current: cur, currentId: defs[cur].id, stages: stagesOut,
      groups: g, groupStatus: gs, payment: pay, dates,
      contacts: { sales: row['MANAGER'] || '', design: row['DESIGN'] || '', interior: row['INTERIOR'] || '' },
      site: { name: issueName, address: row['SITE'] || '', owner: row['NAME'] || '', bmKey: row['BM KEY'] || '' },
    };
  }

  const api = { compute, groupStatus, isDone, isSkipped, isActive, stripSite, payment, PAY_PLAN, FACTORY_STAGES, SITE_STAGES, KW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StageEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
