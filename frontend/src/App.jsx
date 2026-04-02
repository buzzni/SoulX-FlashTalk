import { useState } from 'react'
import './App.css'
import VideoGenerator from './components/VideoGenerator'
import ConversationGenerator from './components/ConversationGenerator'

function App() {
  const [mode, setMode] = useState('single')

  return (
    <div className="App">
      <header className="App-header">
        <h1>I'M SELLER</h1>
        <p>AI 쇼호스트</p>
        <div className="mode-toggle">
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
