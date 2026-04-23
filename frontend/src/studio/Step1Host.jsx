import { useState, useRef, useEffect } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button, Card, Chip, Field, Segmented, UploadTile } from './primitives.jsx';
import { humanizeError, makeRandomSeeds, streamHost, uploadReferenceImage } from './api.js';

// Face/outfit strength is not a real Gemini parameter — the mapping layer (§5.1.2)
// collapses 0–1 into one of four English prompt clauses. A slider pretends to be
// continuous; a 4-button Segmented matches reality. Each option stores the bucket
// midpoint so the threshold lookup still produces the same clause.
const STRENGTH_STEPS = [
  { value: 0.15, label: '느슨하게', hint: '참고 정도' },
  { value: 0.45, label: '참고만', hint: '스타일 힌트' },
  { value: 0.70, label: '가깝게', hint: '핵심 특징 보존' },
  { value: 0.95, label: '똑같이', hint: '최대한 일치' },
];

function strengthValueToStep(v) {
  if (v == null) return 0.70;
  if (v < 0.30) return 0.15;
  if (v < 0.60) return 0.45;
  if (v < 0.85) return 0.70;
  return 0.95;
}

// Step 1 — 쇼호스트 만들기 (비개발자 친화)
const HOST_PRESETS = {
  성별: [
    { value: 'female', label: '여성' },
    { value: 'male', label: '남성' },
  ],
  연령대: [
    { value: '20s', label: '20대 · 젊고 밝은' },
    { value: '30s', label: '30대 · 친근한' },
    { value: '40s', label: '40대 · 신뢰감 있는' },
    { value: '50plus', label: '50대+ · 따뜻한' },
  ],
  '분위기': [
    { value: 'bright', label: '밝고 활기찬' },
    { value: 'calm', label: '차분하고 신뢰감' },
    { value: 'friendly', label: '친근하고 편안' },
    { value: 'pro', label: '전문적이고 세련' },
  ],
  '옷차림': [
    { value: 'formal', label: '정장' },
    { value: 'casual', label: '캐주얼' },
    { value: 'chic', label: '세련된 모던' },
    { value: 'cozy', label: '편안한 홈웨어' },
  ],
};

const EXAMPLE_PROMPTS = [
  '30대 여성, 밝게 웃고 있음, 베이지 니트, 따뜻한 분위기',
  '20대 여성, 활기찬 표정, 화이트 블라우스, 깔끔한 스튜디오',
  '40대 남성, 차분하고 신뢰감 있는 표정, 네이비 셔츠',
];

// Backend only accepts image paths for face/outfit references (faceRefPath /
// outfitRefPath). A text-only mode stored strings the backend had no way to
// consume. Users who want to describe a look in words use the "추가로 바라는 점"
// (extraPrompt) field instead — Gemini sees that on every call.
const RefInput = ({ file, onFile, onRemove, label, sub }) => {
  return (
    <div className="flex-col gap-2">
      <UploadTile
        file={file}
        onFile={onFile}
        onRemove={onRemove}
        label={label}
        sub={sub}
      />
    </div>
  );
};

const Step1Host = ({ state, update }) => {
  const { host } = state;
  const [generating, setGenerating] = useState(false);
  // variants live on host state so they survive a reload — local useState
  // lost them every refresh. setVariants here becomes a thin wrapper around
  // setField('variants', ...) but keeps the "callback updater" shape used
  // in the stream loop (vs => vs.map(...)).
  const variants = host.variants || [];
  const setVariants = (nextOrFn) => {
    update(s => {
      const current = s.host.variants || [];
      const next = typeof nextOrFn === 'function' ? nextOrFn(current) : nextOrFn;
      return { ...s, host: { ...s.host, variants: next } };
    });
  };
  const [errorMsg, setErrorMsg] = useState(null);
  // Counts every successful "쇼호스트 만들기" press (including 다시 만들기).
  // attempt #0 uses the default fixed seed set so two users with the same
  // prompt see comparable outputs; attempt #1+ uses random seeds so retry
  // actually produces different results — see api.makeRandomSeeds.
  // If variants were persisted from a previous session, start at 1 so the
  // user's next "다시 만들기" produces fresh randoms instead of re-running
  // the same deterministic set.
  const [attempts, setAttempts] = useState((host.variants || []).length > 0 ? 1 : 0);
  const resultsRef = useRef(null);

  const setField = (k, v) => update(s => ({ ...s, host: { ...s.host, [k]: v } }));

  // Upload face/outfit to the server the moment the user picks them, instead
  // of waiting for "쇼호스트 만들기". Two wins: (1) the reference photo
  // survives a browser refresh (server URL is persistable, File handles +
  // data URLs aren't), and (2) the generate click doesn't also block on
  // upload, so it feels snappier. On upload success we swap faceRef.url
  // from the transient data URL to the serveable /api/files/… URL so the
  // preview tile keeps working forever.
  const onRefFilePicked = (kind) => async (f) => {
    // First write — instant preview via the data URL UploadTile handed us.
    setField(kind, f);
    if (!f || !f._file) return;  // _fake sample OR no actual File handle
    try {
      const r = await uploadReferenceImage(f._file);
      update(s => ({
        ...s,
        host: {
          ...s.host,
          [kind]: { name: f.name, size: f.size, type: f.type, url: r.url, _file: undefined },
          [`${kind}Path`]: r.path,
        },
      }));
    } catch (err) {
      console.warn(`auto-upload ${kind} failed`, err);
      // Leave faceRef._file in place so the generate click retries upload.
    }
  };

  const onRefFileRemoved = (kind) => () => {
    // Clear both the preview object and the stored server path.
    update(s => ({
      ...s,
      host: { ...s.host, [kind]: null, [`${kind}Path`]: null },
    }));
  };

  // 결과 카드가 나타나면 자동으로 스크롤 (좌측 폼 컬럼 내부 스크롤)
  useEffect(() => {
    if (!(generating || variants.length > 0) || !resultsRef.current) return;
    const scroller = resultsRef.current.closest('.left-col') || document.scrollingElement;
    if (scroller && scroller.scrollTo) {
      const top = resultsRef.current.offsetTop - 80;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  }, [generating, variants.length]);

  const generate = async () => {
    setGenerating(true);
    setErrorMsg(null);
    // First press: use the deterministic [10, 42, 77, 128]. Retries: pick
    // fresh randoms so the user actually sees new output (otherwise same
    // input + same seeds = same 4 images, and "다시 만들기" feels broken).
    const SEEDS = attempts === 0 ? [10, 42, 77, 128] : makeRandomSeeds(4);
    // Placeholders are NOT drawn yet — we wait for the 'init' SSE event
    // to confirm the backend accepted the request. Showing spinners
    // before that meant a validation failure would flash 4 spinners and
    // then leave them stuck on screen.
    setVariants([]);
    try {
      let faceRefPath = host.faceRefPath || null;
      let outfitRefPath = host.outfitRefPath || null;
      if (host.mode !== 'text') {
        if (host.faceRef?._file && !faceRefPath) {
          const r = await uploadReferenceImage(host.faceRef._file);
          faceRefPath = r.path;
          setField('faceRefPath', r.path);
        }
        if (host.outfitRef?._file && !outfitRefPath) {
          const r = await uploadReferenceImage(host.outfitRef._file);
          outfitRefPath = r.path;
          setField('outfitRefPath', r.path);
        }
      }
      // Pass _seeds only on retry — first call lets the backend default win
      // for the explicit "two users see the same starting set" contract.
      // imageSize comes from the shared state.imageQuality so Step 2 follows.
      const req = { ...host, faceRefPath, outfitRefPath, imageSize: state.imageQuality };
      if (attempts > 0) req._seeds = SEEDS;

      let successCount = 0;
      let errorCount = 0;
      const errs = [];
      for await (const evt of streamHost(req)) {
        if (evt.type === 'init') {
          // Request accepted — now safe to show the 4 placeholder spinners.
          // Prefer the seeds the backend echoed back so slot order stays
          // consistent even if we ever let the backend rewrite them.
          const slotSeeds = Array.isArray(evt.seeds) && evt.seeds.length > 0 ? evt.seeds : SEEDS;
          setVariants(slotSeeds.map(s => ({ seed: s, id: `v${s}`, placeholder: true })));
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
            const e = new Error(`후보가 부족해요 (${successCount}/${evt.total})`);
            e.status = 503;
            throw e;
          }
          if (errorCount > 0) {
            console.warn('host generate had partial errors:', errs);
          }
        }
      }
    } catch (err) {
      console.error('host generate failed', err);
      setErrorMsg(humanizeError(err));
    } finally {
      setGenerating(false);
      // Increment regardless of outcome — even a partial-failure attempt
      // shouldn't re-use the deterministic seeds on the next click.
      setAttempts(a => a + 1);
    }
  };

  const selectVariant = (v) => {
    setField('generated', true);
    setField('imageUrl', v.url || null);
    setField('selectedPath', v.path || null);
    setField('selectedSeed', v.seed);
    setField('_gradient', v._gradient || null);
  };

  // image 모드에서 "얼굴" 한 가지는 꼭 입력되어야 생성 가능
  // Face photo is required in image mode — text-only fallback removed.
  const faceReady = !!host.faceRef;

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>1단계 · 쇼호스트 만들기</h1>
        <p>영상에 등장할 사람을 만들어요. 설명을 적거나 사진을 올려주세요.</p>
      </div>

      <Card>
        <div className="flex justify-between items-center" style={{ marginBottom: 14 }}>
          <Segmented
            value={host.mode}
            onChange={v => setField('mode', v)}
            options={[
              { value: 'text', label: '설명으로 만들기', icon: 'wand' },
              { value: 'image', label: '사진으로 만들기', icon: 'image' },
            ]}
          />
          <Badge variant="neutral" icon="info">4장을 비교해서 골라요</Badge>
        </div>

        {host.mode === 'text' ? (
          <div className="flex-col gap-3">
            <Field label="어떤 모습의 쇼호스트를 원하세요?" hint="자유롭게 15자 이상">
              <textarea
                className={`textarea ${host.prompt && host.prompt.length < 15 ? 'invalid' : ''}`}
                placeholder="예) 30대 여성, 밝게 웃고 있음, 베이지 니트, 따뜻한 분위기"
                value={host.prompt || ''}
                onChange={e => setField('prompt', e.target.value)}
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                <span className="text-xs text-tertiary" style={{ alignSelf: 'center' }}>예시 클릭 →</span>
                {EXAMPLE_PROMPTS.map(ex => (
                  <Chip key={ex} onClick={() => setField('prompt', ex)}>{ex.split(',')[0]}</Chip>
                ))}
              </div>
            </Field>

            <div>
              <div className="field-label" style={{ marginBottom: 10, marginTop: 6 }}>또는 조건으로 선택해요</div>
              <div className="flex-col gap-3">
                {Object.keys(HOST_PRESETS).map(key => (
                  <div key={key}>
                    <div className="text-xs text-tertiary" style={{ marginBottom: 6 }}>{key}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {HOST_PRESETS[key].map(o => (
                        <Chip key={o.value} on={host.builder?.[key] === o.value} onClick={() => setField('builder', { ...host.builder, [key]: o.value })}>
                          {o.label}
                        </Chip>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <details style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', userSelect: 'none' }}>피하고 싶은 표현이 있나요? (선택)</summary>
              <input className="input mt-2" placeholder="예) 과한 화장, 어두운 표정"
                value={host.negativePrompt || ''}
                onChange={e => setField('negativePrompt', e.target.value)} />
            </details>
          </div>
        ) : (
          <div className="flex-col gap-3">
            <div style={{ padding: 12, background: 'var(--accent-soft)', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent-soft-border)', fontSize: 12, color: 'var(--accent-text)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Icon name="info" size={14} />
              <div>얼굴 사진이 필요해요. 의상은 비워둬도 됩니다. 원하는 느낌을 더 적으려면 아래 <b>추가로 바라는 점</b> 필드를 쓰세요.</div>
            </div>
            <div className="field-row">
              <Field label="얼굴" hint="꼭 필요해요">
                <RefInput
                  file={host.faceRef}
                  onFile={onRefFilePicked('faceRef')}
                  onRemove={onRefFileRemoved('faceRef')}
                  label="얼굴이 나온 사진 올리기"
                  sub="정면·밝은 사진 추천"
                />
              </Field>
              <Field label="의상" hint="사진이나 글, 둘 다 가능 · 없어도 돼요">
                <RefInput
                  file={host.outfitRef}
                  onFile={onRefFilePicked('outfitRef')}
                  onRemove={onRefFileRemoved('outfitRef')}
                  label="입힐 옷 사진 올리기"
                  sub="원하는 옷차림이 있을 때"
                />
                <input
                  className="input mt-2"
                  placeholder="또는 글로 설명: 예) 베이지 니트, 청바지"
                  value={host.outfitText || ''}
                  onChange={e => setField('outfitText', e.target.value)}
                />
              </Field>
            </div>

            {host.faceRef && (
              <Field label="얼굴을 얼마나 비슷하게?" hint="프롬프트 문구에 반영돼요 (연속 수치가 아님)">
                <Segmented
                  value={strengthValueToStep(host.faceStrength)}
                  onChange={v => setField('faceStrength', v)}
                  options={STRENGTH_STEPS.map(s => ({ value: s.value, label: s.label }))}
                />
              </Field>
            )}

            {host.outfitRef && (
              <Field label="옷을 얼마나 비슷하게?" hint="프롬프트 문구에 반영돼요 (연속 수치가 아님)">
                <Segmented
                  value={strengthValueToStep(host.outfitStrength ?? 0.5)}
                  onChange={v => setField('outfitStrength', v)}
                  options={STRENGTH_STEPS.map(s => ({ value: s.value, label: s.label }))}
                />
              </Field>
            )}

            <Field label="추가로 바라는 점 (선택)">
              <input className="input" placeholder="예) 밝은 표정, 자연스러운 자세" value={host.extraPrompt || ''} onChange={e => setField('extraPrompt', e.target.value)} />
            </Field>
          </div>
        )}

        <hr className="hr" />

        <Field
          label="변동성"
          hint="같은 입력으로 생성해도 얼마나 다양하게 나올지 — 안정적이면 비슷한 4장, 창의적이면 제각각"
        >
          <Segmented
            value={host.temperature ?? 0.7}
            onChange={v => setField('temperature', v)}
            options={[
              { value: 0.4, label: '안정적' },
              { value: 0.7, label: '보통' },
              { value: 1.0, label: '창의적' },
            ]}
          />
        </Field>

        <Field
          label="이미지 품질"
          hint="1단계와 2단계 모두에 적용돼요 · 고화질일수록 생성 시간이 길어져요 (2K ~2배, 4K ~4배)"
        >
          <Segmented
            value={state.imageQuality || '1K'}
            onChange={v => update(s => ({ ...s, imageQuality: v }))}
            options={[
              { value: '1K', label: '표준 (1K)' },
              { value: '2K', label: '고화질 (2K)' },
              { value: '4K', label: '초고화질 (4K)' },
            ]}
          />
        </Field>

        {errorMsg && (
          <div style={{ padding: '10px 12px', marginBottom: 10, background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', color: 'var(--danger)', fontSize: 12 }}>
            <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
            {errorMsg}
          </div>
        )}

        <div className="flex justify-between items-center">
          <div className="text-xs text-tertiary">
            버튼을 누르면 아래에 4개의 후보가 나타나요. 마음에 드는 걸 하나 고르세요.
          </div>
          <Button variant="primary" icon={generating ? undefined : 'sparkles'} onClick={generate} disabled={generating || (host.mode === 'text' ? (!host.prompt || host.prompt.length < 15) : !faceReady)}>
            {generating ? <><span className="spinner"/> 만드는 중…</> : '쇼호스트 만들기'}
          </Button>
        </div>
      </Card>

      {(generating || variants.length > 0 || host.generated) && (
        <div ref={resultsRef}>
          <Card title="↓ 이 중에서 골라주세요" subtitle={generating ? '후보를 만드는 중이에요. 잠시면 나타나요.' : '마음에 드는 후보를 클릭하면 선택돼요.'}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {variants.map((v, i) => {
                if (v.placeholder) {
                  return (
                    <div key={v.id} className="preset-tile" style={{ padding: 0, cursor: 'default' }}>
                      <div className="swatch skeleton-shimmer" style={{ aspectRatio: '9/16', position: 'relative', display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
                        <span className="spinner" style={{ width: 18, height: 18 }} />
                      </div>
                      <div className="name text-tertiary">후보 {i + 1}</div>
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
                      <div className="name text-tertiary">후보 {i + 1}</div>
                    </div>
                  );
                }
                return (
                <button key={v.id}
                  className={`preset-tile ${host.selectedSeed === v.seed ? 'on' : ''}`}
                  onClick={() => selectVariant(v)}
                  style={{ padding: 0 }}
                >
                  <div className="swatch" style={{ aspectRatio: '9/16', background: v.url ? '#0b0d12' : v._gradient, position: 'relative', overflow: 'hidden' }}>
                    {v.url ? (
                      <img src={v.url} alt={`후보 ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', background: `radial-gradient(ellipse 60% 80% at 50% 100%, oklch(0.85 0.03 60 / 0.8), transparent 70%)` }} />
                    )}
                    {host.selectedSeed === v.seed && (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: 'var(--accent)', color: '#fff', borderRadius: 99, width: 20, height: 20, display: 'grid', placeItems: 'center' }}>
                        <Icon name="check" size={12} />
                      </div>
                    )}
                  </div>
                  <div className="name">후보 {i + 1}</div>
                </button>
                );
              })}
            </div>
            {host.generated && (
              <div className="mt-3 flex justify-between items-center">
                <Badge variant="success" icon="check_circle">선택 완료 · 다음 단계로 진행하세요</Badge>
                <Button size="sm" icon="refresh" onClick={generate}>다시 만들기</Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
};

export default Step1Host;
