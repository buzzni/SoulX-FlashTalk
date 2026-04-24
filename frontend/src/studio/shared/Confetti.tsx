/**
 * Confetti — CSS-only celebration for completion states.
 *
 * 24 paper squares falling with hue variance. Absolute-positioned
 * with `pointer-events: none` so it can be dropped inside any
 * relatively-positioned container without breaking clicks. Styles
 * inline so there's no CSS import ordering concern.
 *
 * Extracted in Phase 4d (was duplicated across RenderDashboard
 * and ResultPage — Phase 4e will point the other caller here).
 */

export function Confetti() {
  const pieces = Array.from({ length: 24 });
  return (
    <div className="studio-confetti" aria-hidden="true">
      {pieces.map((_, i) => (
        <span
          key={i}
          style={
            {
              '--x': `${(i * 37) % 100}%`,
              '--d': `${2 + (i % 5) * 0.4}s`,
              '--delay': `${(i * 80) % 1200}ms`,
              '--hue': `${(i * 137) % 360}`,
            } as React.CSSProperties
          }
        />
      ))}
      <style>{`
        .studio-confetti {
          position: absolute; inset: 0; pointer-events: none; overflow: hidden;
        }
        .studio-confetti span {
          position: absolute;
          left: var(--x); top: -12px;
          width: 8px; height: 12px;
          background: oklch(0.75 0.15 var(--hue));
          border-radius: 2px;
          animation: studio-confetti-fall var(--d) linear var(--delay) forwards;
          transform-origin: center;
        }
        @keyframes studio-confetti-fall {
          0% { transform: translateY(-10%) rotate(0deg); opacity: 1; }
          100% { transform: translateY(500%) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
