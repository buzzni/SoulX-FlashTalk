import { useState, useRef, useEffect } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button, Card, Chip, Field, Segmented, UploadTile } from './primitives.jsx';
import { humanizeError, streamHost, uploadReferenceImage } from './api.js';

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
  const [variants, setVariants] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const resultsRef = useRef(null);

  const setField = (k, v) => update(s => ({ ...s, host: { ...s.host, [k]: v } }));

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
    // Fixed slot order matches backend seed order so tiles fill left→right
    // consistently regardless of Gemini completion order.
    const SEEDS = [10, 42, 77, 128];
    setVariants(SEEDS.map(s => ({ seed: s, id: `v${s}`, placeholder: true })));
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
      const req = { ...host, faceRefPath, outfitRefPath };

      let successCount = 0;
      let errorCount = 0;
      const errs = [];
      for await (const evt of streamHost(req)) {
        if (evt.type === 'candidate') {
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
                  onFile={f => setField('faceRef', f)}
                  onRemove={() => setField('faceRef', null)}
                  label="얼굴이 나온 사진 올리기"
                  sub="정면·밝은 사진 추천"
                />
              </Field>
              <Field label="의상" hint="없어도 돼요">
                <RefInput
                  file={host.outfitRef}
                  onFile={f => setField('outfitRef', f)}
                  onRemove={() => setField('outfitRef', null)}
                  label="입힐 옷 사진 올리기"
                  sub="원하는 옷차림이 있을 때"
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
