import { useState } from 'react'
import './App.css'
import VideoGenerator from './components/VideoGenerator'
import ConversationGenerator from './components/ConversationGenerator'
import QueueStatus from './components/QueueStatus'
import HostStudio from './studio/HostStudio.jsx'

function App() {
  const [mode, setMode] = useState('hoststudio')

  // HostStudio owns its own full-viewport layout; render it with a floating mode switcher.
  if (mode === 'hoststudio') {
    return (
      <>
        <div style={{ position: 'fixed', top: 8, right: 8, zIndex: 100, display: 'flex', gap: 4, background: 'rgba(255,255,255,0.9)', padding: 4, borderRadius: 6, boxShadow: '0 2px 6px rgba(0,0,0,0.08)' }}>
          <button
            onClick={() => setMode('hoststudio')}
            style={{ padding: '3px 8px', fontSize: 10, background: '#333', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer' }}
          >HostStudio</button>
          <button
            onClick={() => setMode('single')}
            style={{ padding: '3px 8px', fontSize: 10, background: '#eee', color: '#333', border: 0, borderRadius: 4, cursor: 'pointer' }}
          >Single Host</button>
          <button
            onClick={() => setMode('conversation')}
            style={{ padding: '3px 8px', fontSize: 10, background: '#eee', color: '#333', border: 0, borderRadius: 4, cursor: 'pointer' }}
          >Multi-Agent</button>
        </div>
        <HostStudio />
      </>
    )
  }

  return (
    <div className="App">
      <QueueStatus />
      <header className="App-header">
        <h1>I'M SELLER</h1>
        <p>AI 쇼호스트</p>
        <div className="mode-toggle">
          <button
            className={`mode-button ${mode === 'hoststudio' ? 'active' : ''}`}
            onClick={() => setMode('hoststudio')}
          >
            HostStudio (new)
          </button>
          <button
            className={`mode-button ${mode === 'single' ? 'active' : ''}`}
            onClick={() => setMode('single')}
          >
            Single Host
          </button>
          <button
            className={`mode-button ${mode === 'conversation' ? 'active' : ''}`}
            onClick={() => setMode('conversation')}
          >
            Multi-Agent 대화
          </button>
        </div>
      </header>
      <main>
        {mode === 'single' ? <VideoGenerator /> : <ConversationGenerator />}
      </main>
    </div>
  )
}

export default App
