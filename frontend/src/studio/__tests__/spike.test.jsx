/**
 * Phase -1 React 19 compatibility smoke test.
 * If this passes, useState + useRef + useEffect + event listeners all work under Vitest jsdom + React 19.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PhaseMinusOneSpike from '../PhaseMinusOneSpike'

afterEach(cleanup)

describe('Phase -1 React 19 spike', () => {
  it('renders without throwing', () => {
    render(<PhaseMinusOneSpike />)
    expect(screen.getByTestId('spike-root')).toBeTruthy()
  })

  it('textarea is controlled with initial value', () => {
    render(<PhaseMinusOneSpike />)
    const ta = screen.getByRole('textbox')
    expect(ta.value).toBe('1번 제품을 들고 있어요')
  })

  it('tick counter increments (useEffect + setInterval)', async () => {
    render(<PhaseMinusOneSpike />)
    const getTick = () => screen.getByText(/tick count:/).textContent
    const t0 = getTick()
    await new Promise((r) => setTimeout(r, 250))
    const t1 = getTick()
    expect(t0).not.toBe(t1)
  })
})
