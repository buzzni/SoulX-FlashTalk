import { useState, useRef, useEffect } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button, Card, Chip, Field, Segmented, Slider, UploadTile } from './primitives.jsx';

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

const FACE_TEXT_EXAMPLES = [
  '30대 여성, 부드러운 인상, 긴 생머리',
  '20대 여성, 짧은 단발, 맑은 눈매',
  '40대 남성, 짧은 머리, 각진 턱선, 안경',
];
const OUTFIT_TEXT_EXAMPLES = [
  '베이지 오버사이즈 니트, 화이트 블라우스',
  '네이비 정장 재킷, 실크 셔츠',
  '파스텔 핑크 원피스, 단정한 스타일',
];

// 얼굴/의상 입력: 사진 또는 텍스트
const RefInput = ({ kind, file, onFile, onRemove, text, onText, label, sub, examples, required }) => {
  const [mode, setMode] = useState(file ? 'photo' : (text ? 'text' : 'photo'));
  return (
    <div className="flex-col gap-2">
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: 'photo', label: '사진 올리기', icon: 'upload' },
          { value: 'text', label: '설명으로 적기', icon: 'wand' },
        ]}
      />
      {mode === 'photo' ? (
        <UploadTile
          file={file}
          onFile={f => { onFile(f); if (text) onText(''); }}
          onRemove={onRemove}
          label={label}
          sub={sub}
        />
      ) : (
        <div className="flex-col gap-2">
          <textarea
            className="textarea"
            style={{ minHeight: 70 }}
            placeholder={`예) ${examples[0]}`}
            value={text || ''}
            onChange={e => { onText(e.target.value); if (file) onRemove(); }}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="text-xs text-tertiary" style={{ alignSelf: 'center' }}>예시 →</span>
            {examples.map(ex => (
              <Chip key={ex} onClick={() => { onText(ex); if (file) onRemove(); }}>{ex.split(',')[0]}</Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Step1Host = ({ state, update }) => {
  const { host } = state;
  const [generating, setGenerating] = useState(false);
  const [variants, setVariants] = useState([]);
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

  const generate = () => {
    setGenerating(true);
    setVariants([]);
    setTimeout(() => {
      const seeds = [10, 42, 77, 128];
      const vs = seeds.map((seed, i) => ({
        seed,
        id: `v${seed}`,
        _gradient: `linear-gradient(${160 + i * 20}deg, oklch(0.6 0.1 ${20 + i * 80}), oklch(0.3 0.05 ${40 + i * 80}))`,
      }));
      setVariants(vs);
      setGenerating(false);
    }, 1400);
  };

  const selectVariant = (v) => {
    setField('generated', true);
    setField('imageUrl', null);
    setField('selectedSeed', v.seed);
    setField('_gradient', v._gradient);
  };

  // image 모드에서 "얼굴" 한 가지는 꼭 입력되어야 생성 가능
  const faceReady = !!host.faceRef || !!(host.faceText && host.faceText.trim().length >= 5);

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
              <div>얼굴과 의상 각각 <b>사진</b>을 올리거나 <b>글</b>로 설명할 수 있어요. 편한 방법을 골라주세요.</div>
            </div>
            <div className="field-row">
              <Field label="얼굴" hint="꼭 필요해요">
                <RefInput
                  kind="face"
                  file={host.faceRef}
                  onFile={f => setField('faceRef', f)}
                  onRemove={() => setField('faceRef', null)}
                  text={host.faceText}
                  onText={v => setField('faceText', v)}
                  label="얼굴이 나온 사진 올리기"
                  sub="정면·밝은 사진 추천"
                  examples={FACE_TEXT_EXAMPLES}
                />
              </Field>
              <Field label="의상" hint="없어도 돼요">
                <RefInput
                  kind="outfit"
                  file={host.outfitRef}
                  onFile={f => setField('outfitRef', f)}
                  onRemove={() => setField('outfitRef', null)}
                  text={host.outfitText}
                  onText={v => setField('outfitText', v)}
                  label="입힐 옷 사진 올리기"
                  sub="원하는 옷차림이 있을 때"
                  examples={OUTFIT_TEXT_EXAMPLES}
                />
              </Field>
            </div>

            {host.faceRef && (
              <Field label={`얼굴을 얼마나 비슷하게? · ${Math.round((host.faceStrength ?? 0.7) * 100)}%`} hint="오른쪽일수록 올린 사진과 비슷해져요">
                <Slider value={host.faceStrength ?? 0.7} onChange={v => setField('faceStrength', v)} min={0} max={1} step={0.01} formatValue={v => `${Math.round(v * 100)}%`} />
              </Field>
            )}

            {host.outfitRef && (
              <Field label={`옷을 얼마나 비슷하게? · ${Math.round((host.outfitStrength ?? 0.5) * 100)}%`}>
                <Slider value={host.outfitStrength ?? 0.5} onChange={v => setField('outfitStrength', v)} min={0} max={1} step={0.01} formatValue={v => `${Math.round(v * 100)}%`} />
              </Field>
            )}

            <Field label="추가로 바라는 점 (선택)">
              <input className="input" placeholder="예) 밝은 표정, 자연스러운 자세" value={host.extraPrompt || ''} onChange={e => setField('extraPrompt', e.target.value)} />
            </Field>
          </div>
        )}

        <hr className="hr" />

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
              {generating && variants.length === 0 && Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="preset-tile" style={{ padding: 0, cursor: 'default' }}>
                  <div className="swatch skeleton-shimmer" style={{ aspectRatio: '9/16', position: 'relative', display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
                    <span className="spinner" style={{ width: 18, height: 18 }} />
                  </div>
                  <div className="name text-tertiary">후보 {i + 1}</div>
                </div>
              ))}
              {variants.map((v, i) => (
                <button key={v.id}
                  className={`preset-tile ${host.selectedSeed === v.seed ? 'on' : ''}`}
                  onClick={() => selectVariant(v)}
                  style={{ padding: 0 }}
                >
                  <div className="swatch" style={{ aspectRatio: '9/16', background: v._gradient, position: 'relative' }}>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', background: `radial-gradient(ellipse 60% 80% at 50% 100%, oklch(0.85 0.03 60 / 0.8), transparent 70%)` }} />
                    {host.selectedSeed === v.seed && (
                      <div style={{ position: 'absolute', top: 6, right: 6, background: 'var(--accent)', color: '#fff', borderRadius: 99, width: 20, height: 20, display: 'grid', placeItems: 'center' }}>
                        <Icon name="check" size={12} />
                      </div>
                    )}
                  </div>
                  <div className="name">후보 {i + 1}</div>
                </button>
              ))}
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
