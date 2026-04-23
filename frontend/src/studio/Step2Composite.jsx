import { useState, useRef, useEffect } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button, Card, Chip, Field, Segmented, UploadTile } from './primitives.jsx';
import {
  humanizeError,
  makeRandomSeeds,
  streamComposite,
  uploadBackgroundImage,
  uploadReferenceImage,
} from './api.js';
import ServerFilePicker from './ServerFilePicker.jsx';
import { applyPickedFileToBackground, applyPickedFileToProducts } from './picker_handler.js';

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
  // Persisted on composition state so they survive a reload (same reason as
  // host.variants — nothing sadder than losing 4 composites to a refresh).
  const variants = composition.variants || [];
  const setVariants = (nextOrFn) => {
    update(s => {
      const current = s.composition.variants || [];
      const next = typeof nextOrFn === 'function' ? nextOrFn(current) : nextOrFn;
      return { ...s, composition: { ...s.composition, variants: next } };
    });
  };
  // Same retry-seed contract as Step 1 — first call uses defaults, retries
  // get fresh randoms. If we restored persisted variants, skip the "first
  // attempt" path so users don't get the same 4 composites again.
  const [attempts, setAttempts] = useState((composition.variants || []).length > 0 ? 1 : 0);
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
  // Preview URL is best-effort (FileReader can fail on some local file
  // sources); having the raw File or a server-persisted path is enough to
  // proceed with generation.
  const bgReady = !!(
    background.preset ||
    background.imageUrl ||
    background.url ||
    background._gradient ||
    background._file ||
    background.uploadPath
  );
  const productsReady = products.length > 0 && products.some(p => p.url || p.urlInput || p._file || p.path);
  const canGenerate = bgReady && productsReady;
  // Debug — will help pinpoint why canGenerate stays false when UI says upload done.
  console.log('[Step2] readiness', {
    bgReady,
    productsReady,
    canGenerate,
    bg: { source: background.source, preset: background.preset, hasImageUrl: !!background.imageUrl, imageUrlLen: background.imageUrl?.length, hasFile: !!background._file },
    products: products.map(p => ({ id: p.id, hasUrl: !!p.url, urlLen: p.url?.length, hasFile: !!p._file, hasPath: !!p.path })),
  });

  const [errorMsg, setErrorMsg] = useState(null);

  const generateComposite = async () => {
    setGenerating(true);
    setErrorMsg(null);
    // First call: deterministic seeds for shareable starting set. Retries:
    // fresh randoms so the user actually sees new compositions instead of
    // the same 4 every time they hit "다시 만들기".
    const SEEDS = attempts === 0 ? [10, 42, 77, 128] : makeRandomSeeds(4);
    setVariants(SEEDS.map(s => ({ seed: s, id: `c${s}`, placeholder: true })));
    try {
      const uploadedProducts = await Promise.all((products || []).map(async (p) => {
        if (p.path) return p;
        if (p._file) {
          const r = await uploadReferenceImage(p._file);
          return { ...p, path: r.path };
        }
        return p;
      }));
      update(s => ({ ...s, products: uploadedProducts }));

      let bgWithPath = background;
      if (background.source === 'upload' && background._file && !background.uploadPath) {
        // background._file holds the UploadTile wrapper; drill to the raw File.
        const rawFile = background._file._file || background._file;
        const r = await uploadBackgroundImage(rawFile);
        bgWithPath = { ...background, uploadPath: r.path };
        setBg(bgWithPath);
      }
      if (background.source === 'preset' && typeof background.preset === 'string') {
        const found = BG_PRESETS.find(p => p.id === background.preset);
        bgWithPath = { ...bgWithPath, preset: found || { id: background.preset } };
      }

      let successCount = 0;
      let errorCount = 0;
      const errs = [];
      // Pass _seeds only on retry — first call uses backend default set.
      // imageSize piggybacks on composition so the body builder picks it up.
      const composeReq = {
        ...composition,
        imageSize: state.imageQuality,
        ...(attempts > 0 ? { _seeds: SEEDS } : {}),
      };
      for await (const evt of streamComposite({
        host: { selectedPath: state.host?.selectedPath },
        products: uploadedProducts.filter(p => p.path),
        background: bgWithPath,
        composition: composeReq,
        rembg: composition.rembg !== false,
      })) {
        if (evt.type === 'init') {
          update(s => ({
            ...s,
            composition: { ...s.composition, direction_en: evt.direction_en },
          }));
        } else if (evt.type === 'candidate') {
          successCount += 1;
          setVariants(vs => vs.map(v =>
            v.seed === evt.seed
              ? { ...v, url: evt.url, path: evt.path, placeholder: false }
              : v
          ));
        } else if (evt.type === 'error') {
          errorCount += 1;
          errs.push(`seed ${evt.seed}: ${evt.error}`);
          setVariants(vs => vs.map(v =>
            v.seed === evt.seed ? { ...v, error: evt.error, placeholder: false } : v
          ));
        } else if (evt.type === 'fatal') {
          const e = new Error(evt.error || '알 수 없는 오류');
          e.status = evt.status;
          throw e;
        } else if (evt.type === 'done') {
          if (!evt.min_success_met) {
            const e = new Error(`합성 후보가 부족해요 (${successCount}/${evt.total})`);
            e.status = 503;
            throw e;
          }
          if (errorCount > 0) console.warn('composite had partial errors:', errs);
        }
      }
    } catch (err) {
      console.error('composite generate failed', err);
      setErrorMsg(humanizeError(err));
    } finally {
      setGenerating(false);
      setAttempts(a => a + 1);
    }
  };

  const selectComposite = (v) => {
    update(s => ({
      ...s,
      composition: {
        ...s.composition,
        generated: true,
        selectedSeed: v.seed,
        selectedPath: v.path || null,
        selectedUrl: v.url || null,
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

  // Server-side file picker state — active target is either 'products' or 'bg'.
  const [pickerFor, setPickerFor] = useState(null);
  const handlePickedServerFile = (f) => {
    if (pickerFor === 'bg') {
      setBg(applyPickedFileToBackground(background, f));
    } else if (pickerFor === 'products') {
      setProducts(ps => applyPickedFileToProducts(ps, f));
    }
    setPickerFor(null);
  };

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>2단계 · 제품과 배경 합성하기</h1>
        <p>쇼호스트·제품·배경을 한 장의 사진으로 합쳐요. 이 스틸 이미지가 다음 단계(음성·영상)의 바탕이 돼요.</p>
      </div>

      <Card title="소개할 상품" subtitle="여러 개 추가할 수 있어요. 구도 지시에서 ①②③ 번호로 지칭해요" action={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button icon="file" size="sm" onClick={() => setPickerFor('products')}>서버 파일 선택</Button>
          <Button icon="plus" size="sm" onClick={addProduct}>제품 추가</Button>
        </div>
      }>
        {products.length === 0 || products.every(p => !p.url && !p._file && !p.path) ? (
          <UploadTile
            onFile={f => {
              const next = { id: Date.now().toString(36), url: f.url, name: f.name, source: 'upload', _file: f._file };
              console.log('[Step2] product onFile', { wrapperKeys: Object.keys(f), urlLen: f.url?.length, hasFile: !!f._file, fileIsBlob: f._file instanceof Blob, next });
              setProducts([next]);
            }}
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
                        onChange={e => {
                          const f = e.target.files[0];
                          if (!f) return;
                          // Mirror UploadTile.handleFile: data URL (blob: times out on
                          // network-IP origins) + raw File for the upload call.
                          const reader = new FileReader();
                          reader.onload = (ev) => updateProduct(p.id, {
                            url: ev.target.result,
                            name: f.name,
                            _file: f,
                            path: null,
                          });
                          reader.readAsDataURL(f);
                        }}
                      />
                    </label>
                  )}
                </div>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => removeProduct(p.id)} title="제품 삭제"><Icon name="trash" size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {products.length > 0 && (
          <Field
            label="제품 배경 처리"
            hint="화장품·패션처럼 제품만 보여주고 싶으면 '제거', 음식·가구처럼 배경까지 자연스러운 쪽이 나으면 '유지'"
          >
            <Segmented
              value={composition.rembg === false ? 'keep' : 'remove'}
              onChange={v => setComp({ rembg: v === 'remove' })}
              options={[
                { value: 'remove', label: '배경 제거 (기본)', icon: 'image' },
                { value: 'keep', label: '배경 유지', icon: 'bg' },
              ]}
            />
          </Field>
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
            <div className="flex-col gap-2">
              {background.imageUrl && background.uploadPath && !background._file ? (
                <div className="upload-tile has-file">
                  <div className="file-thumb">
                    <img src={background.imageUrl} alt={background.serverFilename || ''} />
                  </div>
                  <div className="file-meta">
                    <span className="truncate">{background.serverFilename || '(서버 파일)'}</span>
                    <span className="mono">server</span>
                  </div>
                  <div className="file-buttons">
                    <button className="file-btn" onClick={() => setPickerFor('bg')}>
                      <Icon name="swap" size={12} /> 다른 파일
                    </button>
                    <button className="file-btn file-btn-danger" onClick={() => setBg({ _file: null, imageUrl: null, uploadPath: null, serverFilename: null })}>
                      <Icon name="trash" size={12} /> 삭제
                    </button>
                  </div>
                </div>
              ) : (
                <UploadTile
                  file={background._file}
                  onFile={f => {
                    console.log('[Step2] bg onFile', { wrapperKeys: Object.keys(f), urlLen: f.url?.length, hasFile: !!f._file, fileIsBlob: f._file instanceof Blob });
                    setBg({ _file: f, imageUrl: f.url, preset: null, prompt: '', url: '' });
                  }}
                  onRemove={() => setBg({ _file: null, imageUrl: null })}
                  label="배경 사진 올리기"
                  sub="촬영한 매장 사진 등"
                />
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPickerFor('bg')}
                style={{ alignSelf: 'flex-start' }}
                type="button"
              >
                <Icon name="file" size={12} /> 서버에 있는 파일에서 선택
              </button>
            </div>
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

        <Field
          label="변동성"
          hint="같은 입력으로도 결과를 얼마나 다양하게 뽑을지 — 안정적이면 4장이 비슷, 창의적이면 제각각"
        >
          <Segmented
            value={composition.temperature ?? 0.7}
            onChange={v => setComp({ temperature: v })}
            options={[
              { value: 0.4, label: '안정적' },
              { value: 0.7, label: '보통' },
              { value: 1.0, label: '창의적' },
            ]}
          />
        </Field>

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
              {variants.map((v, i) => {
                if (v.placeholder) {
                  return (
                    <div key={v.id} className="preset-tile" style={{ padding: 0, cursor: 'default' }}>
                      <div className="swatch skeleton-shimmer" style={{ aspectRatio: '9/16', position: 'relative', display: 'grid', placeItems: 'center' }}>
                        <span className="spinner" style={{ width: 18, height: 18 }} />
                      </div>
                      <div className="name text-tertiary">합성 {i + 1}</div>
                    </div>
                  );
                }
                if (v.error) {
                  return (
                    <div key={v.id} className="preset-tile" style={{ padding: 0, cursor: 'default', borderColor: 'var(--danger)' }}>
                      <div className="swatch" style={{ aspectRatio: '9/16', display: 'grid', placeItems: 'center', color: 'var(--danger)', fontSize: 10, textAlign: 'center', padding: 6, background: 'var(--danger-soft)' }}>
                        <div>
                          <Icon name="alert_circle" size={16} />
                          <div style={{ marginTop: 4 }}>실패</div>
                        </div>
                      </div>
                      <div className="name text-tertiary">합성 {i + 1}</div>
                    </div>
                  );
                }
                return (
                <button key={v.id}
                  className={`preset-tile ${composition.selectedSeed === v.seed ? 'on' : ''}`}
                  onClick={() => selectComposite(v)}
                  style={{ padding: 0 }}
                >
                  <div className="swatch" style={{ aspectRatio: '9/16', background: '#0b0d12', position: 'relative', overflow: 'hidden' }}>
                    {v.url ? (
                      <img src={v.url} alt={`합성 후보 ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : null}
                    {composition.selectedSeed === v.seed && (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: 'var(--accent)', color: '#fff', borderRadius: 99, width: 20, height: 20, display: 'grid', placeItems: 'center' }}>
                        <Icon name="check" size={12} />
                      </div>
                    )}
                  </div>
                  <div className="name">합성 {i + 1}</div>
                </button>
                );
              })}
            </div>
            {errorMsg && (
              <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', color: 'var(--danger)', fontSize: 12 }}>
                <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
                {errorMsg}
              </div>
            )}
            {composition.generated && (
              <div className="mt-3 flex justify-between items-center">
                <Badge variant="success" icon="check_circle">합성 완료 · 다음 단계로 진행하세요</Badge>
                <Button size="sm" icon="refresh" onClick={generateComposite}>다시 만들기</Button>
              </div>
            )}
          </Card>
        </div>
      )}

      <ServerFilePicker
        open={pickerFor !== null}
        kind="image"
        onClose={() => setPickerFor(null)}
        onSelect={handlePickedServerFile}
      />
    </div>
  );
};

export default Step2Composite;
