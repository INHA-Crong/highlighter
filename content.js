(() => {
  if (window.__bpSpike) return;
  const BP = (window.__bpSpike = { editors: new Map() });

  // 서버 호출로 교체할 지점. 지금은 스파이크용 키워드 목업.
  const PHONE = /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/;
  const MAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
  const YELLOW = /(와이프|남편|아내|아이|엄마|아빠|집에서|회사|출근)/;
  const classify = (s) => (PHONE.test(s) || MAIL.test(s) ? 'R' : YELLOW.test(s) ? 'Y' : 'G');

  // 종결부호는 뒤에 공백/끝이 올 때만 문장 경계로 본다(이메일·URL 안의 '.'에서 안 쪼개짐). 실제 서비스에서는 kss 등으로 교체.
  function sentences(text) {
    const out = [];
    const re = /[^\n]+?(?:[.!?]+[”’"')\]]*(?=\s|$)|(?=\n)|$)/g; // pilot_labeling/split_rule.py 와 같은 규칙
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const t = m[0].trim();
      if (t.length < 2) continue;
      const start = m.index + (m[0].length - m[0].trimStart().length);
      out.push({ start, end: start + t.length, text: t });
    }
    return out;
  }

  const isText = (el) =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search)$/.test(el.type));

  function editableFrom(t) {
    if (!(t instanceof Element)) return null;
    if (isText(t)) return t;
    const CE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
    let ce = t.closest(CE);
    if (ce) {
      for (let p; (p = ce.parentElement && ce.parentElement.closest(CE)); ) ce = p;
      return ce;
    }
    if (t.ownerDocument.designMode === 'on') return t.ownerDocument.body;
    return null;
  }

  // ---- contenteditable: 텍스트 노드 -> 문자열 + 오프셋 지도. DOM은 건드리지 않는다.
  const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|TR)$/;
  const blockOf = (n, root) => {
    for (let e = n.parentElement; e && e !== root; e = e.parentElement) if (BLOCK.test(e.tagName)) return e;
    return root;
  };
  function collect(root, only) {
    const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let text = '', prev = null, n;
    const map = [];
    while ((n = w.nextNode())) {
      if (n.nodeType === 1) { if (n.tagName === 'BR') text += '\n'; continue; }
      if (!n.data) continue;
      if (only && !(n.parentElement && n.parentElement.closest(only))) continue;
      const b = blockOf(n, root);
      if (prev && b !== prev) text += '\n';
      map.push({ node: n, start: text.length });
      text += n.data;
      prev = b;
    }
    return { text, map };
  }
  function toRange(map, s, e) {
    const find = (off) => {
      for (let i = map.length - 1; i >= 0; i--) {
        const m = map[i];
        if (m.start <= off && off <= m.start + m.node.data.length) return [m.node, off - m.start];
      }
      return null;
    };
    const a = find(s), b = find(e);
    if (!a || !b) return null;
    const r = new Range();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    return r;
  }

  function ensureStyle(root) {
    const host = root instanceof ShadowRoot ? root : root.head || root.documentElement;
    if (host.querySelector && host.querySelector('style[data-bp]')) return;
    const s = document.createElement('style');
    s.dataset.bp = '1';
    s.textContent =
      '::highlight(bp-y){background-color:rgba(255,214,0,.55)}::highlight(bp-r){background-color:rgba(255,64,64,.55)}';
    host.appendChild(s);
  }
  // ---- 진단용: 읽은 요소가 실제로 화면에 보이는지, 좌표계가 맞는지 확인
  const r0 = (r) => r && [r.x, r.y, r.width, r.height].map((v) => Math.round(v));
  // 입력 프록시(화면 밖 iframe) 대응: 읽은 문장이 부모/상위 문서 어디에 실제로 그려지는지 찾아 DOM 경로를 로그로 남긴다.
  function discover(el, sents) {
    const best = sents.slice().sort((a, b) => b.text.length - a.text.length)[0];
    const probe = best && best.text.replace(/\s+/g, ' ').slice(0, 12);
    if (!probe || probe.length < 6) return false;
    const out = [];
    let w = el.ownerDocument.defaultView;
    for (let i = 0; i < 4; i++) {
      try {
        const d = w.document;
        const tw = d.createTreeWalker(d.body || d.documentElement, NodeFilter.SHOW_TEXT);
        let n, hits = 0;
        while ((n = tw.nextNode()) && hits < 2) {
          if (!n.data.includes(probe)) continue;
          hits++;
          const chain = [];
          for (let e = n.parentElement, k = 0; e && k < 9; e = e.parentElement, k++)
            chain.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 34)}${e.isContentEditable ? '[CE]' : ''} ${r0(e.getBoundingClientRect())}`);
          out.push({ lvl: i, doc: d.location.href.slice(0, 60), designMode: d.designMode, chain });
        }
        if (!hits) out.push({ lvl: i, doc: d.location.href.slice(0, 60), found: false });
        if (w === w.parent) break;
        w = w.parent;
      } catch (e) { out.push({ lvl: i, err: String(e).slice(0, 40) }); break; }
    }
    console.log('[bp-discover]', JSON.stringify(out));
    return true;
  }
  function applyHighlights() {
    const y = [], r = [];
    BP.editors.forEach((st, el) => {
      if (!el.isConnected) { BP.editors.delete(el); st.mo && st.mo.disconnect(); return; }
      if (st.ranges) { y.push(...st.ranges.Y); r.push(...st.ranges.R); }
    });
    CSS.highlights.set('bp-y', new Highlight(...y));
    CSS.highlights.set('bp-r', new Highlight(...r));
  }

  // ---- textarea/input: 내부 텍스트 노드가 없으므로 투명 미러 오버레이
  function paintTextarea(el, sents, labels) {
    let ov = el.__bpOv;
    if (!ov) {
      ov = document.createElement('div');
      ov.style.cssText =
        'position:absolute;pointer-events:none;overflow:hidden;z-index:2147483646;color:transparent;' +
        'white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box';
      document.body.appendChild(ov);
      el.__bpOv = ov;
    }
    const cs = getComputedStyle(el), rc = el.getBoundingClientRect();
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign',
      'paddingTop', 'paddingLeft', 'paddingBottom'])
      ov.style[k] = cs[k];
    ov.style.border = cs.borderTopWidth + ' solid transparent';
    const scrollbar = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    ov.style.paddingRight = parseFloat(cs.paddingRight) + Math.max(0, scrollbar) + 'px';
    ov.style.left = rc.left + scrollX + 'px';
    ov.style.top = rc.top + scrollY + 'px';
    ov.style.width = rc.width + 'px';
    ov.style.height = rc.height + 'px';
    ov.replaceChildren();
    const text = el.value;
    let pos = 0;
    sents.forEach((s, i) => {
      ov.append(text.slice(pos, s.start));
      const sp = document.createElement('span');
      sp.textContent = text.slice(s.start, s.end);
      if (labels[i] === 'Y') sp.style.background = 'rgba(255,214,0,.55)';
      if (labels[i] === 'R') sp.style.background = 'rgba(255,64,64,.55)';
      ov.append(sp);
      pos = s.end;
    });
    ov.append(text.slice(pos));
    ov.scrollTop = el.scrollTop;
  }

  function analyze(el) {
    const st = BP.editors.get(el);
    const textual = isText(el);
    let text, map;
    if (textual) text = el.value; else ({ text, map } = collect(el, st.only));
    const sents = sentences(text);
    const labels = sents.map((s) => classify(s.text));
    st.last = { kind: textual ? el.tagName.toLowerCase() : 'contenteditable', len: text.length, n: sents.length,
      flagged: sents.map((s, i) => ({ l: labels[i], t: s.text })).filter((x) => x.l !== 'G') };
    if (textual) paintTextarea(el, sents, labels);
    else {
      ensureStyle(el.getRootNode());
      st.ranges = { Y: [], R: [] };
      sents.forEach((s, i) => {
        if (labels[i] === 'G') return;
        const r = toRange(map, s.start, s.end);
        if (r) st.ranges[labels[i]].push(r);
      });
      applyHighlights();
      if ((st.discN || 0) < 2 && text.length >= 12 && discover(el, sents)) st.discN = (st.discN || 0) + 1;
    }
    const d =`${el.tagName.toLowerCase()}#${el.id || ''}.${String(el.className).slice(0, 40)}`;
    console.log('[bp-spike]', st.last.kind, d, `글자 ${text.length}`, `문장 ${st.last.n}`, `경고 ${st.last.flagged.length}`,
      `frame=${window === top ? 'top' : 'iframe'}`, `hl=${CSS.highlights.size}`,
      JSON.stringify(text.slice(0, 40)));
  }

  function schedule(el) {
    const st = BP.editors.get(el);
    clearTimeout(st.t);
    st.t = setTimeout(() => analyze(el), 250);
  }
  function attach(el, only) {
    if (!el || BP.editors.has(el)) return el && schedule(el);
    const st = { ranges: null, only };
    BP.editors.set(el, st);
    if (!isText(el)) {
      st.mo = new MutationObserver(() => schedule(el));
      st.mo.observe(el, { childList: true, characterData: true, subtree: true });
    } else {
      el.addEventListener('scroll', () => schedule(el));
    }
    schedule(el);
  }

  const src = (e) => editableFrom(e.composedPath()[0]);
  document.addEventListener('focusin', (e) => attach(src(e)), true);
  document.addEventListener('input', (e) => attach(src(e)), true);
  addEventListener('resize', () => BP.editors.forEach((_, el) => isText(el) && schedule(el)));

  // 입력을 숨은 iframe으로 받고 본문은 일반 DOM으로 그리는 편집기(네이버 스마트에디터 ONE)용 어댑터.
  // 본문 루트를 직접 지정해 읽고, 같은 문서 안에서 칠한다.
  const ADAPTERS = [{ host: /(^|\.)blog\.naver\.com$/, root: 'article.se-components-wrap', only: '.se-component.se-text' }];
  const adapter = ADAPTERS.find((a) => a.host.test(location.hostname));
  if (adapter) {
    setInterval(() => {
      const root = document.querySelector(adapter.root);
      if (root && !BP.editors.has(root)) { attach(root, adapter.only); console.log('[bp-adapter] attached', adapter.root); }
    }, 1000);
  }

  // 에디터 구조 파악: 각 프레임에서 3초 뒤 contenteditable 목록을 한 번 찍는다.
  setTimeout(() => {
    const list = [...document.querySelectorAll('[contenteditable],[designMode]')].slice(0, 8).map((e) =>
      `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)} ${r0(e.getBoundingClientRect())} len=${(e.textContent || '').length}`);
    if (list.length || document.designMode === 'on')
      console.log('[bp-scan]', window === top ? 'top' : 'iframe', location.href.slice(0, 60), 'designMode=' + document.designMode, list);
  }, 3000);

  BP.report = () => [...BP.editors.values()].map((s) => s.last);
  BP.analyzeNow = (el) => analyze(el);
})();
