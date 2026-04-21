import { useState, useRef, useEffect } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button, Card, Chip, Field, Segmented, UploadTile } from './primitives.jsx';

// Step 2 — 제품 + 배경 + 구도 지시 → 합성 스틸 한 장
const BG_PRESETS = [
  { id: 'studio_white', label: '깔끔한 화이트', desc: '어떤 제품이든 무난', gradient: 'linear-gradient(180deg, oklch(0.97 0.003 95), oklch(0.88 0.005 95))' },
  { id: 'studio_warm', label: '따뜻한 스튜디오', desc: '뷰티·패션', gradient: 'linear-gradient(180deg, oklch(0.9 0.03 60), oklch(0.7 0.05 40))' },
  { id: 'living_cozy', label: '아늑한 거실', desc: '리빙·생활용품', gradient: 'linear-gradient(180deg, oklch(0.75 0.04 60), oklch(0.5 0.05 40))' },
  { id: 'kitchen', label: '모던 주방', desc: '식품·주방용품', gradient: 'linear-gradient(180deg, oklch(0.85 0.015 230), oklch(0.6 0.02 230))' },
  { id: 'outdoor_park', label: '햇살 좋은 야외', desc: '운동·레저', gradient: 'linear-gradient(180deg, oklch(0.8 0.08 150), oklch(0.5 0.08 150))' },
  { id: 'night_neon', label: '네온 야경', desc: '트렌디·젊은 타겟', gradient: 'linear-gradient(180deg, oklch(0.35 0.1 300), oklch(0.2 0.1 260))' },
  { id: 'retail', label: '매장 쇼룸', desc: '패션·가전', gradient: 'linear-gradient(180deg, oklch(0.85 0.02 40), oklch(0.6 0.04 40))' },
  { id: 'solid_blue', label: '블루 단색', desc: '깔끔 강조', gradient: 'linear-gradient(180deg, oklch(0.55 0.15 255), oklch(0.4 0.15 255))' },
];

// 구도 지시 예시 칩 — 배경/상황별로 다양하게
const DIRECTION_EXAMPLES = [
  '소파에 편하게 앉아 1번 상품을 손에 들고 카메라를 바라봄',
  '주방 아일랜드 앞에 서서 1번을 앞으로 내밀어 보여줌',
  '테이블 옆에 서고 1번과 2번 상품을 테이블 위에 나란히 놓음',
  '바닥에 앉아 1번을 무릎 위에 올려놓고 설명하는 자세',
  '선반에 기대 서서 한 손에 1번을 들고 다른 손으로 가리킴',
  '걷다가 잠시 멈춘 듯한 자세로 1번을 양손으로 감싸 쥠',
];

const SHOT_OPTS = [
  { v: 'closeup', label: '클로즈업', sub: '얼굴 중심' },
  { v: 'bust', label: '상반신', sub: '가슴 위' },
  { v: 'medium', label: '미디엄', sub: '허리 위' },
  { v: 'full', label: '풀샷', sub: '전신' },
];
const ANGLE_OPTS = [
  { v: 'eye', label: '정면' },
  { v: 'low', label: '살짝 아래에서' },
  { v: 'high', label: '살짝 위에서' },
];

const Step2Composite = ({ state, update }) => {
  const { products, background, composition = {} } = state;
  const [bgSource, setBgSource] = useState(background.source || 'preset');
  const [dragIdx, setDragIdx] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [variants, setVariants] = useState([]);
  const resultsRef = useRef(null);
  const directionRef = useRef(null);

  const BADGE_CHARS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'];

  const insertProductRef = (idx) => {
    const ref = `${idx + 1}번`;
    const ta = directionRef.current;
    const cur = composition.direction || '';
    if (!ta) {
      setComp({ direction: cur + (cur && !cur.endsWith(' ') ? ' ' : '') + ref + ' ' });
      return;
    }
    const s = ta.selectionStart ?? cur.length;
    const e = ta.selectionEnd ?? cur.length;
    const insert = ref + ' ';
    const next = cur.slice(0, s) + insert + cur.slice(e);
    setComp({ direction: next });
    // 커서 위치 유지
    requestAnimationFrame(() => {
      if (!directionRef.current) return;
      const pos = s + insert.length;
      directionRef.current.focus();
      directionRef.current.setSelectionRange(pos, pos);
    });
  };

  const setBg = (patch) => update(s => ({ ...s, background: { ...s.background, ...patch } }));
  const setProducts = (next) => update(s => ({ ...s, products: typeof next === 'function' ? next(s.products) : next }));
  const setComp = (patch) => update(s => ({ ...s, composition: { ...s.composition, ...patch } }));

  const addProduct = () => {
    setProducts(ps => [...ps, { id: Date.now().toString(36), url: null, source: 'upload' }]);
  };
  const updateProduct = (id, patch) => {
    setProducts(ps => ps.map(p => p.id === id ? { ...p, ...patch } : p));
  };
  const removeProduct = (id) => setProducts(ps => ps.filter(p => p.id !== id));

  const onDragStart = (idx) => setDragIdx(idx);
  const onDragOver = (e, idx) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    setProducts(ps => {
      const next = [...ps];
      const [m] = next.splice(dragIdx, 1);
      next.splice(idx, 0, m);
      setDragIdx(idx);
      return next;
    });
  };
  const onDragEnd = () => setDragIdx(null);

  const [generatingBg, setGeneratingBg] = useState(false);
  const generateBg = () => {
    setGeneratingBg(true);
    setTimeout(() => {
      setBg({
        source: 'prompt',
        prompt: background.prompt,
        imageUrl: null,
        _gradient: `linear-gradient(${Math.random() * 360}deg, oklch(0.7 0.08 ${Math.random() * 360}), oklch(0.4 0.08 ${Math.random() * 360}))`,
        preset: null,
      });
      setGeneratingBg(false);
    }, 1200);
  };

  // 합성 스틸 생성 (후보 4장)
  const bgReady = !!(background.preset || background.imageUrl || background.url || background._gradient);
  const productsReady = products.length > 0 && products.some(p => p.url || p.urlInput);
  const canGenerate = bgReady && productsReady;

  const generateComposite = () => {
    setGenerating(true);
    setVariants([]);
    setTimeout(() => {
      const seeds = [11, 29, 51, 93];
      const hostGrad = state.host?._gradient || 'linear-gradient(160deg, oklch(0.6 0.08 30), oklch(0.3 0.05 40))';
      const bgGrad = background._gradient || BG_PRESETS.find(p => p.id === background.preset)?.gradient || 'linear-gradient(180deg, oklch(0.9 0.01 90), oklch(0.7 0.02 90))';
      const vs = seeds.map((seed, i) => ({
        seed,
        id: `c${seed}`,
        _bg: bgGrad,
        _host: hostGrad,
        _hostX: [28, 62, 35, 58][i],
        _hostScale: [0.82, 0.78, 0.9, 0.74][i],
        _productY: [72, 68, 78, 66][i],
      }));
      setVariants(vs);
      setGenerating(false);
    }, 1500);
  };

  const selectComposite = (v) => {
    update(s => ({
      ...s,
      composition: {
        ...s.composition,
        generated: true,
        selectedSeed: v.seed,
        _previewBg: v._bg,
        _previewHost: v._host,
        _hostX: v._hostX,
        _hostScale: v._hostScale,
        _productY: v._productY,
      },
    }));
  };

  // 결과 자동 스크롤
  useEffect(() => {
    if (!(generating || variants.length > 0) || !resultsRef.current) return;
    const scroller = resultsRef.current.closest('.left-col') || document.scrollingElement;
    if (scroller && scroller.scrollTo) {
      const top = resultsRef.current.offsetTop - 80;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  }, [generating, variants.length]);

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>2단계 · 제품과 배경 합성하기</h1>
        <p>쇼호스트·제품·배경을 한 장의 사진으로 합쳐요. 이 스틸 이미지가 다음 단계(음성·영상)의 바탕이 돼요.</p>
      </div>

      <Card title="소개할 상품" subtitle="여러 개 추가할 수 있어요. 구도 지시에서 ①②③ 번호로 지칭해요" action={
        <Button icon="plus" size="sm" onClick={addProduct}>제품 추가</Button>
      }>
        {products.length === 0 ? (
          <UploadTile
            onFile={f => setProducts([{ id: Date.now().toString(36), url: f.url, source: 'upload', _file: f }])}
            label="제품 사진 올리기"
            sub="배경이 없는 PNG가 제일 깔끔해요"
          />
        ) : (
          <div className="product-list">
            {products.map((p, idx) => (
              <div key={p.id}
                className={`product-row ${dragIdx === idx ? 'dragging' : ''}`}
                draggable
                onDragStart={() => onDragStart(idx)}
                onDragOver={e => onDragOver(e, idx)}
                onDragEnd={onDragEnd}
              >
                <span className="product-drag" title="끌어서 순서 변경"><Icon name="drag" /></span>
                <div className="product-thumb">
                  {p.url ? <img src={p.url} alt="" /> : <div className="striped-placeholder" style={{ fontSize: 9 }}>상품 {idx+1}</div>}
                </div>
                <div className="product-info flex-col gap-2">
                  <div className="product-label text-xs">
                    상품 {idx+1}
                    <span className="text-tertiary" style={{ marginLeft: 6, fontWeight: 400 }}>· 구도 지시에서 <strong style={{ color: 'var(--accent)', fontWeight: 600 }}>{idx+1}번</strong></span>
                  </div>
                  <Segmented
                    value={p.source}
                    onChange={v => updateProduct(p.id, { source: v })}
                    options={[{ value: 'upload', label: '사진 올리기', icon: 'upload' }, { value: 'url', label: '쇼핑몰 주소', icon: 'link' }]}
                  />
                  {p.source === 'url' && (
                    <div className="input-group">
                      <span className="prefix"><Icon name="link" size={12} /></span>
                      <input className="input has-prefix" placeholder="예) https://smartstore.naver.com/..."
                        value={p.urlInput || ''}
                        onChange={e => updateProduct(p.id, { urlInput: e.target.value })}
                      />
                    </div>
                  )}
                  {p.source === 'upload' && (
                    <label className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}>
                      <Icon name={p.url ? 'swap' : 'upload'} size={12} />
                      {p.url ? '사진 교체' : '사진 올리기'}
                      <input type="file" accept="image/*" style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files[0]; if (f) updateProduct(p.id, { url: URL.createObjectURL(f) }); }}
                      />
                    </label>
                  )}
                </div>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => removeProduct(p.id)} title="제품 삭제"><Icon name="trash" size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="배경" subtitle="어디서 촬영한 느낌으로 보이게 할지 골라주세요">
        <Segmented
          value={bgSource}
          onChange={v => { setBgSource(v); setBg({ source: v }); }}
          options={[
            { value: 'preset', label: '추천 장소에서 고르기', icon: 'frame' },
            { value: 'upload', label: '내 사진 사용', icon: 'upload' },
            { value: 'url', label: '링크로 가져오기', icon: 'link' },
            { value: 'prompt', label: '직접 만들기', icon: 'wand' },
          ]}
        />

        <div className="mt-3">
          {bgSource === 'preset' && (
            <div className="preset-grid">
              {BG_PRESETS.map(p => (
                <button key={p.id} className={`preset-tile ${background.preset === p.id ? 'on' : ''}`}
                  onClick={() => setBg({ preset: p.id, _gradient: p.gradient, imageUrl: null, prompt: '', url: '' })}
                >
                  <div className="swatch" style={{ background: p.gradient }} />
                  <div className="name">
                    <div>{p.label}</div>
                    <div className="text-xs text-tertiary" style={{ fontWeight: 400, marginTop: 1 }}>{p.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {bgSource === 'upload' && (
            <UploadTile
              file={background._file}
              onFile={f => setBg({ _file: f, imageUrl: f.url, preset: null, prompt: '', url: '' })}
              onRemove={() => setBg({ _file: null, imageUrl: null })}
              label="배경 사진 올리기"
              sub="촬영한 매장 사진 등"
            />
          )}
          {bgSource === 'url' && (
            <Field label="이미지 주소">
              <div className="input-group">
                <span className="prefix"><Icon name="link" size={12} /></span>
                <input className="input has-prefix" placeholder="예) https://... 로 시작하는 이미지 링크"
                  value={background.url || ''}
                  onChange={e => setBg({ url: e.target.value, imageUrl: null, preset: null, prompt: '' })}
                />
              </div>
            </Field>
          )}
          {bgSource === 'prompt' && (
            <div className="flex-col gap-3">
              <Field label="어떤 배경이 필요한가요?" hint="장소·분위기를 적어주세요">
                <textarea
                  className="textarea"
                  placeholder="예) 밝고 깨끗한 모던 주방, 큰 창문으로 자연광이 들어오는 느낌"
                  value={background.prompt || ''}
                  onChange={e => setBg({ prompt: e.target.value })}
                />
              </Field>
              <div className="flex justify-between items-center">
                <div className="text-xs text-tertiary">적으신 내용으로 새 배경을 만들어드려요</div>
                <Button variant="primary" size="sm" icon={generatingBg ? undefined : 'sparkles'} onClick={generateBg} disabled={generatingBg || !background.prompt}>
                  {generatingBg ? <><span className="spinner"/> 만드는 중</> : '배경 만들기'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="구도 — 어떻게 놓여있게 할까요?"
        subtitle="쇼호스트 자세·제품 위치를 자유롭게 적어주세요. 배경에 있는 가구·공간에 맞춰 합성돼요."
      >
        <Field label="구도 지시" hint="한 문장으로 적어도 되고, 여러 제품을 따로 적어도 돼요">
          <div className="hl-textarea">
            <div className="hl-textarea__mirror" aria-hidden>
              {(() => {
                const text = composition.direction || '';
                if (!text) return '\u00A0';
                // Match "1번", "2번"... — digits immediately followed by 번
                const parts = text.split(/(\d+번)/);
                return parts.map((chunk, i) => {
                  const match = chunk.match(/^(\d+)번$/);
                  if (match) {
                    const n = parseInt(match[1], 10);
                    if (n >= 1 && products[n - 1]) {
                      return <mark key={i} className="hl-mark">{chunk}</mark>;
                    }
                  }
                  return <span key={i}>{chunk}</span>;
                });
              })()}
              {/* trailing newline ensures mirror grows with cursor */}
              <span>{'\u200B'}</span>
            </div>
            <textarea
              ref={directionRef}
              className="textarea hl-textarea__input"
              rows={3}
              placeholder="예) 소파에 앉아 1번은 손에 들고, 2번은 옆 테이블 위에 놓기"
              value={composition.direction || ''}
              onChange={e => setComp({ direction: e.target.value })}
              onScroll={e => {
                const mirror = e.target.previousSibling;
                if (mirror) mirror.scrollTop = e.target.scrollTop;
              }}
            />
          </div>
        </Field>

        {products.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="text-xs text-tertiary" style={{ marginRight: 2 }}>번호 넣기</span>
            {products.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className="product-ref-chip"
                onClick={() => insertProductRef(i)}
                title={`${i+1}번 상품 입력`}
              >
                <span className="product-ref-thumb">
                  {p.url ? <img src={p.url} alt="" /> : <span className="product-ref-thumb__empty" />}
                </span>
                <span className="product-ref-text"><strong>{i+1}</strong>번</span>
              </button>
            ))}
          </div>
        )}

        <div className="text-xs text-tertiary" style={{ marginTop: 14, marginBottom: 6 }}>예시 · 클릭하면 통째로 입력돼요</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DIRECTION_EXAMPLES.map(ex => (
            <Chip key={ex} onClick={() => setComp({ direction: ex })}>{ex}</Chip>
          ))}
        </div>

        <hr className="hr" />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="샷 크기">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SHOT_OPTS.map(o => (
                <Chip key={o.v} on={composition.shot === o.v} onClick={() => setComp({ shot: o.v })}>
                  {o.label}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label="카메라 앵글">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ANGLE_OPTS.map(o => (
                <Chip key={o.v} on={composition.angle === o.v} onClick={() => setComp({ angle: o.v })}>
                  {o.label}
                </Chip>
              ))}
            </div>
          </Field>
        </div>

        <hr className="hr" />

        <div className="flex justify-between items-center">
          <div className="text-xs text-tertiary">
            버튼을 누르면 아래에 4장의 합성 후보가 나타나요. 마음에 드는 걸 하나 고르세요.
          </div>
          <Button
            variant="primary"
            icon={generating ? undefined : 'sparkles'}
            onClick={generateComposite}
            disabled={generating || !canGenerate}
          >
            {generating ? <><span className="spinner"/> 합성 중…</> : '합성 이미지 만들기'}
          </Button>
        </div>
        {!canGenerate && (
          <div className="text-xs text-tertiary" style={{ marginTop: 6 }}>
            {!productsReady && '제품 사진을 먼저 올려주세요. '}
            {!bgReady && '배경을 선택해주세요.'}
          </div>
        )}
      </Card>

      {(generating || variants.length > 0 || composition.generated) && (
        <div ref={resultsRef}>
          <Card
            title="↓ 합성 결과 · 이 중에서 골라주세요"
            subtitle={generating ? '배경·제품·쇼호스트를 합성하는 중이에요. 잠시만 기다려주세요.' : '마음에 드는 후보를 클릭하면 선택돼요.'}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {generating && variants.length === 0 && Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="preset-tile" style={{ padding: 0, cursor: 'default' }}>
                  <div className="swatch skeleton-shimmer" style={{ aspectRatio: '9/16', position: 'relative', display: 'grid', placeItems: 'center' }}>
                    <span className="spinner" style={{ width: 18, height: 18 }} />
                  </div>
                  <div className="name text-tertiary">합성 {i + 1}</div>
                </div>
              ))}
              {variants.map((v, i) => (
                <button key={v.id}
                  className={`preset-tile ${composition.selectedSeed === v.seed ? 'on' : ''}`}
                  onClick={() => selectComposite(v)}
                  style={{ padding: 0 }}
                >
                  <div className="swatch" style={{ aspectRatio: '9/16', background: v._bg, position: 'relative', overflow: 'hidden' }}>
                    {/* 쇼호스트 실루엣 */}
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: `${v._hostX}%`,
                      transform: `translateX(-50%) scale(${v._hostScale})`,
                      transformOrigin: 'bottom center',
                      width: '55%',
                      height: '88%',
                      background: v._host,
                      borderRadius: '40% 40% 10% 10% / 50% 50% 10% 10%',
                      opacity: 0.92,
                    }} />
                    {/* 제품 점 표시 */}
                    <div style={{
                      position: 'absolute',
                      left: `${v._hostX > 50 ? 22 : 72}%`,
                      top: `${v._productY}%`,
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: 'oklch(0.85 0.1 60)',
                      border: '1.5px solid oklch(0.3 0.05 60)',
                      transform: 'translate(-50%, -50%)',
                    }} />
                    {composition.selectedSeed === v.seed && (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: 'var(--accent)', color: '#fff', borderRadius: 99, width: 20, height: 20, display: 'grid', placeItems: 'center' }}>
                        <Icon name="check" size={12} />
                      </div>
                    )}
                  </div>
                  <div className="name">합성 {i + 1}</div>
                </button>
              ))}
            </div>
            {composition.generated && (
              <div className="mt-3 flex justify-between items-center">
                <Badge variant="success" icon="check_circle">합성 완료 · 다음 단계로 진행하세요</Badge>
                <Button size="sm" icon="refresh" onClick={generateComposite}>다시 만들기</Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
};

export default Step2Composite;
