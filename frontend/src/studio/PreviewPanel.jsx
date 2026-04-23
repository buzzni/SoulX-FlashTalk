// Preview panel — right-column 9:16 phone frame.
// Step 1: not rendered (the candidate grid on the left IS the preview; a second
//         copy in the right column was redundant and ate screen space). Host
//         confirmation happens via the selection check on the grid tile.
// Step 2: shows the Step 1 host you picked as a reference card — "who am I
//         composing with" — rather than the composite output (which is already
//         previewed as you click grid candidates).
// Step 3: shows the final composite + ready badges.
import Icon from './Icon.jsx';
import { Badge } from './primitives.jsx';

const PreviewPanel = ({ state, step = 1 }) => {
  // Step 1: render nothing. Caller collapses the .main grid to a single column
  // so the left form gets the full width.
  if (step === 1) return null;

  const { host, background, voice, resolution, composition = {} } = state;

  const hostReady = host.imageUrl || host.generated;
  const compositeReady = composition.generated;
  const compositeImageUrl = composition.selectedUrl || null;

  const previewTitle = step === 2 ? '선택한 쇼호스트'
    : '영상에 들어갈 한 장';
  const previewSub = step === 2 ? '1단계에서 고른 쇼호스트 · 이 인물로 합성돼요'
    : `${resolution.label} · ${resolution.width}×${resolution.height} · 최종 영상은 만들기 버튼을 눌러주세요`;

  const showComposite = compositeReady && step >= 3;

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
            {step === 2 && hostReady && (
              // Step 2 reference card: the Step 1 host the user selected.
              // Matches Step 1's own visual style (beige studio backdrop)
              // so it reads as "this is who you picked".
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

            {step === 2 && !hostReady && (
              <div className="preview-empty">
                <Icon name="sparkles" size={22} />
                <div>1단계에서 쇼호스트를 먼저<br/>만들고 선택해주세요</div>
              </div>
            )}

            {step === 3 && showComposite && compositeImageUrl && (
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

            {step === 3 && !showComposite && (
              <div className="preview-empty">
                <Icon name="sparkles" size={22} />
                <div>앞 단계를 먼저 완료해주세요</div>
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
