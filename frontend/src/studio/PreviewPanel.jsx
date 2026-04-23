// Preview panel — 9:16 phone frame. Ported from prototype PreviewPanel.jsx.
import { useMemo } from 'react';
import Icon from './Icon.jsx';
import { Badge } from './primitives.jsx';

const PreviewPanel = ({ state, step = 1 }) => {
  const { host, background, products, voice, resolution, composition = {} } = state;

  const hostReady = host.imageUrl || host.generated;
  const bgReady = background.imageUrl || background.preset || background.prompt || background.url;
  const compositeReady = composition.generated;
  // After Step 2 candidate selection, selectedUrl is the actual generated PNG.
  // Mirror Step 1's host.imageUrl flow so the right preview shows the real
  // image, not the gradient/silhouette placeholder we used pre-generation.
  const compositeImageUrl = composition.selectedUrl || null;

  const waveBars = useMemo(() => Array.from({ length: 24 }, (_, i) => 0.3 + Math.abs(Math.sin(i * 0.7)) * 0.7), []);

  const showLiveOverlay = false;
  const showWaveform = false;

  const previewTitle = step === 1 ? '쇼호스트 미리보기'
    : step === 2 ? '합성 이미지 미리보기'
    : '영상에 들어갈 한 장';
  const previewSub = step === 1 ? '세로 · 9:16'
    : step === 2 ? '다음 단계(음성·영상)의 바탕이 되는 한 장'
    : `${resolution.label} · ${resolution.width}×${resolution.height} · 최종 영상은 만들기 버튼을 눌러주세요`;

  const showComposite = compositeReady && step >= 2;
  const showHostOnly = step === 1 && hostReady;
  const hasAnyLayer = showComposite || showHostOnly || (step >= 2 && (hostReady || bgReady));

  return (
    <div className="right-col">
      <div className="preview-header">
        <div>
          <h3>{previewTitle}</h3>
          <div className="sub">{previewSub}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Badge variant="neutral" icon="preview">{step < 4 ? '미리보기' : '예상 화면'}</Badge>
        </div>
      </div>
      <div className="preview-body">
        <div className="phone-frame">
          <div className="phone-content">
            {step === 1 && hostReady && (
              <>
                <div className="preview-bg" style={{ background: 'linear-gradient(180deg, oklch(0.96 0.005 90), oklch(0.88 0.008 90))' }} />
                {host.imageUrl ? (
                  <div className="preview-host" style={{ backgroundImage: `url(${host.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center top' }} />
                ) : (
                  <div className="preview-host" style={{ background: host._gradient || undefined }}>
                    <div className="host-placeholder" />
                  </div>
                )}
              </>
            )}

            {step >= 2 && showComposite && compositeImageUrl && (
              <div
                className="preview-host"
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: `url(${compositeImageUrl})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />
            )}

            {step >= 2 && showComposite && !compositeImageUrl && (
              // Fallback: Step 2 marked composition.generated=true but for some
              // reason we have no selectedUrl (legacy state, race, etc.) — keep
              // the old silhouette placeholder so the panel doesn't go blank.
              <>
                <div className="preview-bg" style={{ background: composition._previewBg || background._gradient }} />
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: `${composition._hostX ?? 50}%`,
                  transform: `translateX(-50%) scale(${composition._hostScale ?? 0.85})`,
                  transformOrigin: 'bottom center',
                  width: '55%',
                  height: '88%',
                  background: composition._previewHost || host._gradient,
                  borderRadius: '40% 40% 10% 10% / 50% 50% 10% 10%',
                  opacity: 0.92,
                }} />
              </>
            )}

            {step === 2 && !showComposite && (bgReady || hostReady) && (
              <>
                {bgReady && (
                  <div className="preview-bg" style={{
                    background: background._gradient || 'linear-gradient(180deg, oklch(0.85 0.02 90), oklch(0.6 0.03 90))',
                    backgroundImage: background.imageUrl ? `url(${background.imageUrl})` : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }} />
                )}
                {hostReady && (
                  <div className="preview-host" style={{
                    backgroundImage: host.imageUrl ? `url(${host.imageUrl})` : undefined,
                    background: !host.imageUrl ? (host._gradient || undefined) : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center top',
                    opacity: 0.9,
                  }} />
                )}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'oklch(0 0 0 / 0.35)',
                  color: 'white',
                  fontSize: 12,
                  textAlign: 'center',
                  padding: 20,
                  lineHeight: 1.5,
                }}>
                  <div>
                    <Icon name="sparkles" size={22} /><br/>
                    <span style={{ opacity: 0.9 }}>"합성 이미지 만들기" 버튼을 눌러<br/>한 장으로 합쳐주세요</span>
                  </div>
                </div>
              </>
            )}

            {!hasAnyLayer && (
              <div className="preview-empty">
                <Icon name="sparkles" size={22} />
                <div>
                  {step === 1 && <>왼쪽에서 쇼호스트를 만들면<br/>여기에 미리보기가 나타나요</>}
                  {step === 2 && <>제품과 배경을 넣고 합성하면<br/>여기에 결과가 나타나요</>}
                  {step === 3 && <>앞 단계를 먼저 완료해주세요</>}
                  {step === 4 && <>앞 단계를 먼저 완료해주세요</>}
                </div>
              </div>
            )}

            {showLiveOverlay && hasAnyLayer && (
              <div className="preview-topbar">
                <div className="live-pill"><span className="live-dot"/>라이브</div>
                <div className="viewer-pill">👁 1,284명 시청 중</div>
              </div>
            )}

            {showWaveform && (
              <div className="preview-waveform">
                {waveBars.map((h, i) => <span key={i} className="wave-bar" style={{ height: `${h * 100}%` }} />)}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-elev)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <span>쇼호스트 {hostReady ? <Badge variant="success" icon="check">준비됨</Badge> : <Badge>준비 전</Badge>}</span>
          <span>합성 {compositeReady ? <Badge variant="success" icon="check">완료</Badge> : <Badge>준비 전</Badge>}</span>
          <span>목소리 {voice.voiceId || voice.uploadedAudio || voice.generated ? <Badge variant="success" icon="check">준비됨</Badge> : <Badge>준비 전</Badge>}</span>
        </div>
      </div>
    </div>
  );
};

export default PreviewPanel;
