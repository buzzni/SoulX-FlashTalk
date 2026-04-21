/**
 * Phase -1 React 19 compatibility spike.
 *
 * Exercises the 3 APIs that prototype heavily uses:
 * - useState (state management)
 * - useRef + useEffect (hl-textarea mirror highlight pattern in Step2Composite)
 * - useEffect cleanup (timer-based progress bar for 20s wait UX)
 *
 * Delete this file after Phase 3 kickoff. It's a canary, not production.
 */
import { useState, useRef, useEffect } from 'react'

export default function PhaseMinusOneSpike() {
  const [count, setCount] = useState(0)
  const [textValue, setTextValue] = useState('1번 제품을 들고 있어요')
  const mirrorRef = useRef(null)
  const textareaRef = useRef(null)

  // Simulates Step2Composite hl-textarea scroll sync (prototype lines 303-336).
  useEffect(() => {
    const handler = () => {
      if (mirrorRef.current && textareaRef.current) {
        mirrorRef.current.scrollTop = textareaRef.current.scrollTop
      }
    }
    const ta = textareaRef.current
    ta?.addEventListener('scroll', handler)
    return () => ta?.removeEventListener('scroll', handler)
  }, [])

  // Simulates 20s wait progress bar tick (plan §6.3).
  useEffect(() => {
    const id = setInterval(() => setCount((c) => c + 1), 100)
    return () => clearInterval(id)
  }, [])

  const highlightedText = textValue.replace(
    /(\d+번)/g,
    '<mark style="background: rgba(80,120,240,0.25)">$1</mark>',
  )

  return (
    <div data-testid="spike-root" style={{ padding: 16, fontFamily: 'monospace' }}>
      <h3>Phase -1 React 19 Spike</h3>
      <div>tick count: {count}</div>
      <div style={{ position: 'relative', marginTop: 8 }}>
        <div
          ref={mirrorRef}
          dangerouslySetInnerHTML={{ __html: highlightedText }}
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            whiteSpace: 'pre-wrap',
            color: 'transparent',
            padding: 8,
            overflow: 'auto',
          }}
        />
        <textarea
          ref={textareaRef}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          rows={4}
          style={{ width: '100%', padding: 8, background: 'transparent', position: 'relative' }}
        />
      </div>
    </div>
  )
}
