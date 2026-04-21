import { useState, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button, Card, Field, Slider, UploadTile } from './primitives.jsx';
import { cloneVoice, generateVoice, humanizeError, listVoices, uploadAudio } from './api.js';

// Step 3 — 목소리 (비개발자 친화)
const VOICE_PRESETS = [
  { id: 'v_minji', name: '민지', lang: '한국어', desc: '밝고 경쾌한 느낌의 20대 여성', tag: '라이브커머스 추천' },
  { id: 'v_sora', name: '소라', lang: '한국어', desc: '차분하고 부드러운 30대 여성', tag: '뷰티·라이프' },
  { id: 'v_jiho', name: '지호', lang: '한국어', desc: '친근하고 밝은 30대 남성', tag: '가전·IT' },
  { id: 'v_hayoon', name: '하윤', lang: '한국어', desc: '활기차고 귀여운 20대 여성', tag: '패션' },
  { id: 'v_dohyun', name: '도현', lang: '한국어', desc: '안정적이고 신뢰감 있는 40대 남성', tag: '프리미엄' },
  { id: 'v_sena', name: '세나', lang: '한국어', desc: '따뜻하고 자연스러운 30대 여성', tag: '리빙·식품' },
];

const BREATH_TAG = ' [breath] '; // 좌우 공백 포함 (9 chars)
const SCRIPT_LIMIT = 5000;

const RES_OPTIONS = [
  { key: '448p', label: '보통 화질', tag: '448p', width: 448, height: 768, size: '약 8MB', speed: '가장 빠름', default: true },
  { key: '480p', label: '기본 화질', tag: '480p', width: 480, height: 832, size: '약 14MB', speed: '빠름' },
  { key: '720p', label: '고화질(HD)', tag: '720p', width: 720, height: 1280, size: '약 28MB', speed: '보통' },
  { key: '1080p', label: '최고 화질(FHD)', tag: '1080p', width: 1080, height: 1920, size: '약 62MB', speed: '느림' },
];

const buildScript = (paragraphs) => {
  return (paragraphs || [])
    .map(p => (p || '').trim())
    .filter(p => p.length > 0)
    .join(BREATH_TAG);
};

const Step3Audio = ({ state, update }) => {
  const { voice } = state;
  const setV = (patch) => update(s => ({ ...s, voice: { ...s.voice, ...patch } }));
  const setR = (r) => update(s => ({ ...s, resolution: r }));
  const { resolution } = state;
  const [generating, setGenerating] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Fetch real voices from /api/elevenlabs/voices; fall back to hardcoded presets.
  const [remoteVoices, setRemoteVoices] = useState(null);
  const [voicesError, setVoicesError] = useState(null);
  useEffect(() => {
    let alive = true;
    listVoices()
      .then(r => { if (alive) setRemoteVoices(r.voices || []); })
      .catch(err => { if (alive) setVoicesError(err.message || '목소리 목록을 불러오지 못했어요'); });
    return () => { alive = false; };
  }, []);
  const voiceList = remoteVoices && remoteVoices.length > 0
    ? remoteVoices.map(v => ({
        id: v.voice_id,
        name: v.name,
        desc: v.labels?.description || v.labels?.descriptive || v.category || '',
        preview_url: v.preview_url,
        lang: v.labels?.language || '',
      }))
    : VOICE_PRESETS;

  // Preview audio refs — one for voice-tile previews, one for generated output.
  const previewAudioRef = useRef(null);
  const generatedAudioRef = useRef(null);
  const [playingPreview, setPlayingPreview] = useState(null);

  const playVoicePreview = (voiceItem) => {
    if (!voiceItem.preview_url) return;
    const el = previewAudioRef.current;
    if (!el) return;
    if (playingPreview === voiceItem.id) {
      el.pause();
      setPlayingPreview(null);
      return;
    }
    el.src = voiceItem.preview_url;
    el.play().then(() => setPlayingPreview(voiceItem.id)).catch(() => setPlayingPreview(null));
  };

  const playGenerated = () => {
    const el = generatedAudioRef.current;
    if (!el || !voice.generatedAudioPath) return;
    el.src = voice.generatedAudioPath.startsWith('http')
      ? voice.generatedAudioPath
      : `${window.location.protocol}//${window.location.hostname}:8001/api/files/${voice.generatedAudioPath}`;
    el.play().catch(() => {});
  };

  // Ensure paragraphs always exists with at least one entry
  const paragraphs = (voice.paragraphs && voice.paragraphs.length > 0) ? voice.paragraphs : [''];
  const combinedScript = buildScript(paragraphs);
  const totalLen = combinedScript.length; // 내부 저장용 (breath 포함)
  const estDuration = Math.round(combinedScript.replace(/\[breath\]/g, '').replace(/\s+/g, '').length * 0.3);

  // 사용자에게 보여줄 글자수 계산 — [breath] 분량은 숨김
  // 유효 입력 가능 수 = 5000 - (문단 사이사이 [breath] 태그 길이 합)
  const nonEmptyCount = paragraphs.filter(p => (p || '').trim().length > 0).length;
  const breathOverhead = Math.max(0, nonEmptyCount - 1) * BREATH_TAG.length;
  const userTypedLen = paragraphs.reduce((sum, p) => sum + (p || '').length, 0);
  const effectiveLimit = SCRIPT_LIMIT - breathOverhead;
  const remaining = SCRIPT_LIMIT - totalLen;

  // Keep voice.script synced with combined output so downstream (Step4, validation) still works
  const syncScript = (nextParagraphs) => {
    const combined = buildScript(nextParagraphs);
    setV({ paragraphs: nextParagraphs, script: combined });
    update(s => ({ ...s, script: combined }));
  };

  const updateParagraph = (idx, value) => {
    // Compute what the new combined length would be; if exceeds, clip the input
    const next = paragraphs.slice();
    const others = next.filter((_, i) => i !== idx).map(p => (p || '').trim()).filter(p => p.length > 0);
    const baseLen = others.join(BREATH_TAG).length + (others.length > 0 ? BREATH_TAG.length : 0);
    const available = SCRIPT_LIMIT - baseLen;
    const trimmedValue = value.length > available ? value.slice(0, Math.max(0, available)) : value;
    next[idx] = trimmedValue;
    syncScript(next);
  };

  const addParagraph = () => {
    if (remaining < BREATH_TAG.length + 1) return; // no room for another
    syncScript([...paragraphs, '']);
  };

  const removeParagraph = (idx) => {
    if (idx === 0) return; // 첫 문단은 삭제 불가
    const next = paragraphs.filter((_, i) => i !== idx);
    syncScript(next.length > 0 ? next : ['']);
  };

  const tabs = [
    { id: 'tts', label: '목소리 고르기', icon: 'mic' },
    { id: 'clone', label: '내 목소리 복제', icon: 'copy' },
    { id: 'upload', label: '녹음 파일 업로드', icon: 'upload' },
  ];

  const [errorMsg, setErrorMsg] = useState(null);

  const generate = async () => {
    setGenerating(true);
    setErrorMsg(null);
    try {
      // Three source paths:
      //  - tts: call /api/elevenlabs/generate with voice.voiceId + script
      //  - clone: upload sample → clone-voice → voice_id → generate
      //  - upload: user uploaded raw audio; upload it and keep the path
      let voiceIdForGen = voice.voiceId;
      if (voice.source === 'clone') {
        if (!voice.cloneSample?._file && !voice.cloneSample?.voiceId) {
          throw new Error('클론용 샘플 음성을 올려주세요');
        }
        if (!voice.cloneSample?.voiceId) {
          const cloneResult = await cloneVoice(voice.cloneSample._file);
          voiceIdForGen = cloneResult.voice_id;
          setV({ cloneSample: { ...voice.cloneSample, voiceId: cloneResult.voice_id } });
        } else {
          voiceIdForGen = voice.cloneSample.voiceId;
        }
      }
      if (voice.source === 'upload') {
        if (!voice.uploadedAudio?._file && !voice.uploadedAudio?.path) {
          throw new Error('음성 파일을 업로드해주세요');
        }
        if (voice.uploadedAudio._file && !voice.uploadedAudio.path) {
          const r = await uploadAudio(voice.uploadedAudio._file);
          setV({ uploadedAudio: { ...voice.uploadedAudio, path: r.path }, generated: true });
        } else {
          setV({ generated: true });
        }
        return;
      }

      const voiceForGen = { ...voice, voiceId: voiceIdForGen };
      const result = await generateVoice({ voice: voiceForGen });
      setV({ generated: true, generatedAudioPath: result.path || result.audio_path, voiceId: voiceIdForGen });
    } catch (err) {
      console.error('voice generate failed', err);
      setErrorMsg(humanizeError(err));
    } finally {
      setGenerating(false);
    }
  };

  const canAddParagraph = remaining >= BREATH_TAG.length + 1;

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>3단계 · 목소리와 영상</h1>
        <p>읽을 목소리와 대본을 정하고, 영상 화질까지 골라주세요.</p>
      </div>

      <Card>
        <div className="tabs">
          {tabs.map(t => (
            <button key={t.id} className={`tab ${voice.source === t.id ? 'on' : ''}`} onClick={() => setV({ source: t.id })}>
              <Icon name={t.icon} size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
              {t.label}
            </button>
          ))}
        </div>

        {(voice.source === 'tts' || voice.source === 'clone') && (
          <>
            {voice.source === 'tts' && (
              <Field
                label="목소리 선택"
                hint={voicesError ? '백엔드에 연결되면 실제 목소리 목록이 뜹니다' : '재생 버튼으로 미리 들어보세요'}
              >
                <div className="voice-list">
                  {voiceList.map(v => (
                    <div
                      key={v.id}
                      className={`voice-item ${voice.voiceId === v.id ? 'on' : ''}`}
                      onClick={() => setV({ voiceId: v.id, voiceName: v.name })}
                    >
                      <div className="voice-avatar">{v.name[0]}</div>
                      <div className="voice-info">
                        <div className="voice-name">{v.name}</div>
                        <div className="voice-meta">{v.desc || v.lang || ''}</div>
                      </div>
                      <button
                        className="btn btn-ghost btn-icon btn-sm voice-play"
                        title={v.preview_url ? '미리 듣기' : '미리듣기 샘플이 없어요'}
                        disabled={!v.preview_url}
                        onClick={e => { e.stopPropagation(); playVoicePreview(v); }}
                      >
                        <Icon name={playingPreview === v.id ? 'pause' : 'play'} size={10} />
                      </button>
                    </div>
                  ))}
                </div>
                <audio
                  ref={previewAudioRef}
                  onEnded={() => setPlayingPreview(null)}
                  onPause={() => setPlayingPreview(null)}
                  style={{ display: 'none' }}
                />
              </Field>
            )}

            {voice.source === 'clone' && (
              <div className="flex-col gap-3">
                <div style={{ padding: 12, background: 'var(--accent-soft)', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent-soft-border)', fontSize: 12, color: 'var(--accent-text)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <Icon name="info" size={14} />
                  <div>본인 또는 성우의 녹음 파일을 올리면, 그 목소리 그대로 대본을 읽어드려요. 조용한 곳에서 녹음한 10초 이상의 깨끗한 파일을 추천해요.</div>
                </div>
                <Field label="참고할 녹음 파일" hint="MP3 또는 WAV">
                  <UploadTile
                    file={voice.cloneSample}
                    onFile={f => setV({ cloneSample: f, voiceId: 'cloned_' + Date.now(), voiceName: '내 목소리' })}
                    onRemove={() => setV({ cloneSample: null, voiceId: null })}
                    accept="audio/*"
                    label="녹음 파일 올리기"
                    sub="10초 이상, 주변 소음 없는 파일"
                  />
                </Field>
                {voice.cloneSample && (
                  <div className="flex items-center gap-3" style={{ padding: 12, background: 'var(--success-soft)', borderRadius: 'var(--r-sm)' }}>
                    <Icon name="check_circle" size={16} style={{ color: 'var(--success)' }} />
                    <div className="text-sm" style={{ color: 'var(--success)' }}>
                      목소리 준비 완료! 이제 이 목소리로 대본을 읽어드려요.
                    </div>
                  </div>
                )}
              </div>
            )}

            <hr className="hr" />

            <Field
              label="읽을 대본"
              hint={
                <span>
                  문단과 문단 사이에는 짧은 텀을 두고 자연스럽게 이어 읽어요 · 전체 <strong style={{ color: remaining < 200 ? 'var(--danger)' : 'var(--text-secondary)' }}>{totalLen.toLocaleString()}</strong> / {SCRIPT_LIMIT.toLocaleString()}자
                </span>
              }
            >
              <div className="script-paragraphs">
                {paragraphs.map((p, idx) => (
                  <React.Fragment key={idx}>
                    {idx > 0 && (
                      <div className="breath-divider" aria-hidden>
                        <span className="breath-dot" />
                      </div>
                    )}
                    <div className="script-paragraph">
                      <div className="script-paragraph__header">
                        <span className="script-paragraph__label">문단 {idx + 1}</span>
                        {idx !== 0 && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm paragraph-delete-btn"
                            onClick={() => removeParagraph(idx)}
                          >
                            <Icon name="trash" size={11} style={{ marginRight: 4 }} />
                            삭제
                          </button>
                        )}
                      </div>
                      <textarea
                        className="textarea"
                        style={{ minHeight: 90 }}
                        placeholder={idx === 0
                          ? '예) 안녕하세요 여러분! 오늘 소개해드릴 제품은 정말 특별한데요, 한 번 써보시면 왜 다들 칭찬하는지 바로 아실 거예요.'
                          : '다음 문단을 적어주세요. 앞 문단을 읽고 짧게 텀을 둔 뒤 이어서 읽어요.'}
                        value={p}
                        onChange={e => updateParagraph(idx, e.target.value)}
                      />
                    </div>
                  </React.Fragment>
                ))}
              </div>
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm add-paragraph-btn"
                  onClick={addParagraph}
                  disabled={!canAddParagraph}
                  title={canAddParagraph ? '문단 추가' : '5000자 한도에 도달했어요'}
                >
                  <Icon name="plus" size={12} style={{ marginRight: 5 }} />
                  문단 추가
                </button>
              </div>
            </Field>

            <div className="field-row" style={{ marginTop: 12 }}>
              <Field label={`읽는 속도 · ${(voice.speed ?? 1).toFixed(2)}배`} hint="0.5배 ~ 1.8배">
                <Slider value={voice.speed ?? 1} onChange={v => setV({ speed: v })} min={0.5} max={1.8} step={0.05} formatValue={v => `${v.toFixed(2)}x`} />
              </Field>
              <Field label={`목소리 높낮이 · ${voice.pitch > 0 ? '+' : ''}${voice.pitch ?? 0}`} hint="−6 낮게 ~ +6 높게">
                <Slider value={voice.pitch ?? 0} onChange={v => setV({ pitch: v })} min={-6} max={6} step={1} formatValue={v => (v > 0 ? `+${v}` : v)} />
              </Field>
            </div>

            <details style={{ marginTop: 12 }} open={advancedOpen} onToggle={e => setAdvancedOpen(e.target.open)}>
              <summary style={{ cursor: 'pointer', userSelect: 'none', fontSize: 12, color: 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name={advancedOpen ? 'chevron_up' : 'chevron_down'} size={11} />
                목소리 세밀 조정 (고급, 대부분 그대로 두셔도 괜찮아요)
              </summary>
              <div className="field-row-3" style={{ marginTop: 10 }}>
                <Field label={`일정함 · ${Math.round((voice.stability ?? 0.5) * 100)}`} hint="높을수록 기복 적음">
                  <Slider value={voice.stability ?? 0.5} onChange={v => setV({ stability: v })} min={0} max={1} step={0.01} formatValue={v => Math.round(v * 100)} />
                </Field>
                <Field label={`말투 강조 · ${Math.round((voice.style ?? 0.3) * 100)}`} hint="높을수록 감정 표현">
                  <Slider value={voice.style ?? 0.3} onChange={v => setV({ style: v })} min={0} max={1} step={0.01} formatValue={v => Math.round(v * 100)} />
                </Field>
                <Field label={`원본 유사도 · ${Math.round((voice.similarity ?? 0.75) * 100)}`} hint="목소리 복제 시">
                  <Slider value={voice.similarity ?? 0.75} onChange={v => setV({ similarity: v })} min={0} max={1} step={0.01} formatValue={v => Math.round(v * 100)} />
                </Field>
              </div>
            </details>

            {errorMsg && (
              <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', color: 'var(--danger)', fontSize: 12 }}>
                <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
                {errorMsg}
              </div>
            )}

            <div className="flex justify-between items-center mt-3">
              <div className="text-xs text-tertiary">
                {voice.generated ? <Badge variant="success" icon="check_circle">음성 준비 완료 · {estDuration}초</Badge> : '목소리를 고르고 대본을 적은 뒤 만들기 버튼을 눌러주세요'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  size="sm"
                  icon="play"
                  disabled={!voice.generated || !voice.generatedAudioPath}
                  onClick={playGenerated}
                >
                  미리 듣기
                </Button>
                <Button variant="primary" icon={generating ? undefined : 'sparkles'} onClick={generate} disabled={generating || !voice.voiceId || !combinedScript}>
                  {generating ? <><span className="spinner"/> 만드는 중</> : '음성 만들기'}
                </Button>
              </div>
              <audio ref={generatedAudioRef} style={{ display: 'none' }} />
            </div>
          </>
        )}

        {voice.source === 'upload' && (
          <div className="flex-col gap-3">
            <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Icon name="info" size={14} />
              <div>직접 녹음한 MP3·WAV 파일을 그대로 영상에 넣고 싶을 때 사용하세요.</div>
            </div>
            <Field label="녹음 파일" hint="MP3, WAV, M4A · 최대 50MB">
              <UploadTile
                file={voice.uploadedAudio}
                onFile={f => setV({ uploadedAudio: f, voiceId: 'uploaded', generated: true })}
                onRemove={() => setV({ uploadedAudio: null, voiceId: null, generated: false })}
                accept="audio/*"
                label="녹음 파일 올리기"
                sub="MP3, WAV, M4A"
              />
            </Field>
            <Field label="자막으로 표시할 대본 (선택)" hint="영상에 자막을 보여주고 싶을 때만">
              <textarea
                className="textarea"
                placeholder="녹음 내용을 그대로 적어주시면 영상에 자막으로 나와요."
                value={voice.script || ''}
                onChange={e => { setV({ script: e.target.value }); update(s => ({ ...s, script: e.target.value })); }}
              />
            </Field>
          </div>
        )}
      </Card>

      <Card title="영상 화질" subtitle="세로 영상 · 어디에 올릴지에 맞춰서 고르세요">
        <div className="res-grid">
          {RES_OPTIONS.map(r => (
            <button key={r.key} className={`res-tile ${resolution.key === r.key ? 'on' : ''}`} onClick={() => setR({ ...r })}>
              <div className="res-label" style={{ marginBottom: 6 }}>{r.label}</div>
              <div className="res-dim">{r.tag} · {r.width}×{r.height}</div>
              <div className="res-meta">
                <span>용량 {r.size}</span>
                <span>{r.speed}</span>
              </div>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
};

export default Step3Audio;
