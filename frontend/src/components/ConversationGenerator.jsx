import { useState, useEffect, useRef } from 'react'
import './ConversationGenerator.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8001'

function ConversationGenerator() {
  // Agents
  const [agents, setAgents] = useState([
    { id: 'A', name: '호스트 A', face_image_path: null, voice_id: '', imagePreview: null, prompt: '' },
    { id: 'B', name: '호스트 B', face_image_path: null, voice_id: '', imagePreview: null, prompt: '' },
  ])

  // Dialog turns
  const [turns, setTurns] = useState([
    { agent: 'A', text: '' },
    { agent: 'B', text: '' },
  ])

  // Layout
  const [layout, setLayout] = useState('split')

  // FlashTalk params
  const [prompt, setPrompt] = useState('')
  const [seed, setSeed] = useState(9999)
  const [cpuOffload, setCpuOffload] = useState(true)
  const [resolution, setResolution] = useState('1280x720')

  // Scene prompt (Gemini background generation)
  const [scenePrompt, setScenePrompt] = useState('')

  // Reference images (product images, etc.)
  const [refImages, setRefImages] = useState([]) // [{path, preview, name}]

  // Composite preview (Gemini-generated)
  const [compositeLoading, setCompositeLoading] = useState(false)
  const [compositePreviews, setCompositePreviews] = useState({}) // agentId -> url

  // ElevenLabs voices
  const [voices, setVoices] = useState([])
  const [voicesLoading, setVoicesLoading] = useState(false)

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [error, setError] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [taskId, setTaskId] = useState(null)

  // Config
  const [appConfig, setAppConfig] = useState(null)

  const eventSourceRef = useRef(null)

  // Load config + voices on mount
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/config`)
      .then(r => r.json())
      .then(data => {
        setAppConfig(data)
        setPrompt(data.default_prompt || '')
        setSeed(data.default_seed || 9999)
        setCpuOffload(data.cpu_offload ?? true)

        // Set default images for agents
        if (data.default_host_image_female) {
          const femalePath = data.default_host_image_female
          setAgents(prev => prev.map((a, i) => i === 0 ? {
            ...a,
            face_image_path: femalePath,
            imagePreview: `${API_BASE_URL}/api/files/${femalePath}`,
          } : a))
        }
        if (data.default_host_image_male) {
          const malePath = data.default_host_image_male
          setAgents(prev => prev.map((a, i) => i === 1 ? {
            ...a,
            face_image_path: malePath,
            imagePreview: `${API_BASE_URL}/api/files/${malePath}`,
          } : a))
        }

        // Load voices then set defaults
        loadVoices(data)
      })
      .catch(err => console.error('Config load failed:', err))
  }, [])

  const loadVoices = async (appCfg) => {
    setVoicesLoading(true)
    try {
      const r = await fetch(`${API_BASE_URL}/api/elevenlabs/voices`)
      const data = await r.json()
      const voiceList = data.voices || []
      setVoices(voiceList)

      // Set default voices if config provided
      if (appCfg && voiceList.length > 0) {
        const femaleVoice = voiceList.find(v => v.name.includes('JiYoung'))
        const maleVoice = voiceList.find(v => v.name.includes('JoonPark'))
        if (femaleVoice) {
          setAgents(prev => prev.map((a, i) => i === 0 && !a.voice_id ? { ...a, voice_id: femaleVoice.voice_id } : a))
        }
        if (maleVoice) {
          setAgents(prev => prev.map((a, i) => i === 1 && !a.voice_id ? { ...a, voice_id: maleVoice.voice_id } : a))
        }
      }
    } catch (err) {
      console.error('Failed to load voices:', err)
    } finally {
      setVoicesLoading(false)
    }
  }

  // Agent handlers
  const updateAgent = (index, field, value) => {
    setAgents(prev => prev.map((a, i) => i === index ? { ...a, [field]: value } : a))
  }

  const handleAgentImageUpload = async (index, e) => {
    const file = e.target.files[0]
    if (!file) return

    updateAgent(index, 'imagePreview', URL.createObjectURL(file))

    const formData = new FormData()
    formData.append('file', file)
    try {
      const r = await fetch(`${API_BASE_URL}/api/upload/host-image`, { method: 'POST', body: formData })
      const data = await r.json()
      updateAgent(index, 'face_image_path', data.path)
    } catch (err) {
      setError('이미지 업로드 실패')
    }
  }

  const handleRefImageUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const preview = URL.createObjectURL(file)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const r = await fetch(`${API_BASE_URL}/api/upload/reference-image`, { method: 'POST', body: formData })
      const data = await r.json()
      setRefImages(prev => [...prev, { path: data.path, preview, name: file.name }])
    } catch (err) {
      setError('참조 이미지 업로드 실패')
    }
    e.target.value = ''
  }

  const removeRefImage = (index) => {
    setRefImages(prev => prev.filter((_, i) => i !== index))
  }

  // Generate composite preview via Gemini scene generation
  const generateCompositePreview = async (promptText) => {
    const agentsWithImages = agents.filter(a => a.face_image_path)
    if (!promptText.trim() || agentsWithImages.length === 0) return

    setCompositeLoading(true)
    setCompositePreviews({})

    try {
      const hostPaths = agentsWithImages.map(a => a.face_image_path)

      const refPaths = refImages.map(r => r.path)

      const formData = new FormData()
      formData.append('host_image_paths', JSON.stringify(hostPaths))
      formData.append('resolution', resolution)
      formData.append('layout', layout)
      formData.append('scene_prompt', promptText)
      formData.append('reference_image_paths', JSON.stringify(refPaths))

      const r = await fetch(`${API_BASE_URL}/api/preview/composite-together`, { method: 'POST', body: formData })
      if (r.ok) {
        const data = await r.json()
        const newPreviews = {}
        // Per-agent cropped images (for video generation reference)
        Object.entries(data.paths).forEach(([idx, path]) => {
          const agent = agentsWithImages[parseInt(idx)]
          if (agent) {
            const filename = path.replace(/\\/g, '/').split('/').pop()
            newPreviews[agent.id] = `${API_BASE_URL}/api/files/${filename}?t=${Date.now()}`
          }
        })
        // Full uncropped image for preview display
        if (data.full_image) {
          const fullFilename = data.full_image.replace(/\\/g, '/').split('/').pop()
          newPreviews['_full'] = `${API_BASE_URL}/api/files/${fullFilename}?t=${Date.now()}`
        }
        setCompositePreviews(newPreviews)
      }
    } catch (err) {
      console.error('Composite preview failed:', err)
    } finally {
      setCompositeLoading(false)
    }
  }

  // Turn handlers
  const addTurn = () => {
    const lastAgent = turns.length > 0 ? turns[turns.length - 1].agent : 'A'
    const nextAgent = lastAgent === 'A' ? 'B' : 'A'
    setTurns(prev => [...prev, { agent: nextAgent, text: '' }])
  }

  const removeTurn = (index) => {
    if (turns.length <= 1) return
    setTurns(prev => prev.filter((_, i) => i !== index))
  }

  const updateTurn = (index, field, value) => {
    setTurns(prev => prev.map((t, i) => i === index ? { ...t, [field]: value } : t))
  }

  // Generate conversation
  const handleGenerate = async () => {
    // Validate
    const hasEmptyText = turns.some(t => !t.text.trim())
    if (hasEmptyText) {
      setError('모든 대화 턴에 텍스트를 입력하세요')
      return
    }

    const missingVoice = agents.some(a => !a.voice_id)
    if (missingVoice) {
      setError('모든 에이전트에 음성을 선택하세요')
      return
    }

    setIsGenerating(true)
    setError(null)
    setVideoUrl(null)
    setProgress(0)
    setStage('')
    setStatusMessage('')

    const dialogData = {
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        face_image_path: a.face_image_path || '',
        voice_id: a.voice_id,
        prompt: a.prompt || '',
        scene_prompt: scenePrompt || '',
        reference_image_paths: refImages.map(r => r.path),
      })),
      dialog: turns.map(t => ({
        agent: t.agent,
        text: t.text,
      })),
    }

    const formData = new FormData()
    formData.append('dialog_data', JSON.stringify(dialogData))
    formData.append('layout', layout)
    formData.append('prompt', prompt)
    formData.append('seed', seed)
    formData.append('cpu_offload', cpuOffload)
    formData.append('resolution', resolution)

    try {
      const r = await fetch(`${API_BASE_URL}/api/generate-conversation`, { method: 'POST', body: formData })
      if (!r.ok) {
        const err = await r.json()
        throw new Error(err.detail || 'Generation failed')
      }
      const data = await r.json()
      setTaskId(data.task_id)

      // SSE progress
      const es = new EventSource(`${API_BASE_URL}/api/progress/${data.task_id}`)
      eventSourceRef.current = es

      es.onmessage = (event) => {
        const u = JSON.parse(event.data)
        setProgress(u.progress * 100)
        setStage(u.stage)
        setStatusMessage(u.message)

        if (u.stage === 'complete') {
          setIsGenerating(false)
          setVideoUrl(`${API_BASE_URL}/api/videos/${data.task_id}`)
          es.close()
        } else if (u.stage === 'error') {
          setIsGenerating(false)
          setError(u.message)
          es.close()
        }
      }

      es.onerror = () => { es.close() }
    } catch (err) {
      setError(err.message || '대화 영상 생성 실패')
      setIsGenerating(false)
    }
  }

  useEffect(() => {
    return () => { eventSourceRef.current?.close() }
  }, [])

  const layoutOptions = [
    { value: 'split', label: 'Split', desc: '좌우 분할 (토론 스타일)' },
    { value: 'switch', label: 'Switch', desc: '발언자 전환 (전체 화면)' },
    { value: 'pip', label: 'PiP', desc: '화면 속 화면' },
  ]

  return (
    <div className="conversation-generator">
      <div className="conv-container">
        {/* Left Panel - Settings */}
        <div className="conv-input-panel">
          <h2>대화 설정</h2>

          {/* Agents Setup */}
          <div className="agents-section">
            {agents.map((agent, idx) => (
              <div key={agent.id} className="agent-card">
                <div className="agent-card-header">
                  <span className={`agent-badge agent-badge-${agent.id}`}>{agent.id}</span>
                  <input
                    type="text"
                    className="agent-name-input"
                    value={agent.name}
                    onChange={(e) => updateAgent(idx, 'name', e.target.value)}
                    disabled={isGenerating}
                  />
                </div>

                {/* Face Image */}
                <div className="agent-field">
                  <label>얼굴 이미지</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleAgentImageUpload(idx, e)}
                    disabled={isGenerating}
                  />
                  {agent.imagePreview && (
                    <div className="agent-image-preview">
                      <img src={agent.imagePreview} alt={agent.name} />
                    </div>
                  )}
                  {!agent.face_image_path && <small>기본값 사용</small>}
                </div>

                {/* Voice Selection */}
                <div className="agent-field">
                  <label>
                    음성 (ElevenLabs)
                    {idx === 0 && (
                      <button className="refresh-btn" onClick={loadVoices} disabled={voicesLoading}>
                        {voicesLoading ? '...' : '새로고침'}
                      </button>
                    )}
                  </label>
                  <select
                    value={agent.voice_id}
                    onChange={(e) => updateAgent(idx, 'voice_id', e.target.value)}
                    disabled={isGenerating || voicesLoading}
                  >
                    <option value="">음성을 선택하세요</option>
                    {voices.map(v => (
                      <option key={v.voice_id} value={v.voice_id}>
                        {v.name} {v.category ? `(${v.category})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Per-Agent Prompt */}
                <div className="agent-field">
                  <label>프롬프트 (선택)</label>
                  <textarea
                    className="agent-prompt-input"
                    value={agent.prompt || ''}
                    onChange={(e) => updateAgent(idx, 'prompt', e.target.value)}
                    placeholder="에이전트별 프롬프트 (비워두면 공통 프롬프트 사용)"
                    rows={2}
                    disabled={isGenerating}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Dialog Script Editor */}
          <div className="dialog-section">
            <div className="dialog-header">
              <h3>대화 스크립트</h3>
              <button className="add-turn-btn" onClick={addTurn} disabled={isGenerating}>
                + 턴 추가
              </button>
            </div>

            <div className="turns-list">
              {turns.map((turn, idx) => {
                const agent = agents.find(a => a.id === turn.agent)
                return (
                  <div key={idx} className={`turn-item turn-agent-${turn.agent}`}>
                    <div className="turn-header">
                      <select
                        className="turn-agent-select"
                        value={turn.agent}
                        onChange={(e) => updateTurn(idx, 'agent', e.target.value)}
                        disabled={isGenerating}
                      >
                        {agents.map(a => (
                          <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
                        ))}
                      </select>
                      <button
                        className="remove-turn-btn"
                        onClick={() => removeTurn(idx)}
                        disabled={isGenerating || turns.length <= 1}
                        title="턴 삭제"
                      >
                        ×
                      </button>
                    </div>
                    <textarea
                      value={turn.text}
                      onChange={(e) => updateTurn(idx, 'text', e.target.value)}
                      placeholder={`${agent?.name || turn.agent}의 대사를 입력하세요...`}
                      rows={2}
                      disabled={isGenerating}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          {/* Layout Selection */}
          <div className="form-group">
            <label><strong>레이아웃</strong></label>
            <div className="layout-grid">
              {layoutOptions.map(opt => (
                <label key={opt.value} className={`layout-option ${layout === opt.value ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="layout"
                    value={opt.value}
                    checked={layout === opt.value}
                    onChange={() => setLayout(opt.value)}
                    disabled={isGenerating}
                  />
                  <span className="layout-label">{opt.label}</span>
                  <span className="layout-desc">{opt.desc}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Resolution */}
          <div className="form-group">
            <label><strong>해상도</strong></label>
            <div className="resolution-grid">
              {[
                { value: '768x448', label: '448p' },
                { value: '1280x720', label: '720p' },
                { value: '832x480', label: '480p' },
                { value: '1920x1080', label: '1080p' },
              ].map(r => (
                <label key={r.value} className={`resolution-option ${resolution === r.value ? 'active' : ''}`}>
                  <input type="radio" name="conv-resolution" value={r.value} checked={resolution === r.value} onChange={() => setResolution(r.value)} disabled={isGenerating} />
                  <span className="resolution-label">{r.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Scene Generation (Gemini) */}
          <div className="form-group scene-generation-group">
            <label><strong>배경 생성 (Gemini)</strong> <span className="optional-tag">선택</span></label>

            {/* Scene Prompt */}
            <textarea
              className="scene-prompt-input"
              value={scenePrompt}
              onChange={(e) => setScenePrompt(e.target.value)}
              placeholder="예: A modern Samsung Galaxy studio with large screens showing smartphones, professional studio lighting"
              rows={3}
              disabled={isGenerating}
            />

            {/* Reference Images */}
            <div className="ref-images-section">
              <label className="ref-label">참조 이미지 <span className="optional-tag">상품, 브랜딩 등</span></label>
              <input type="file" accept="image/*" onChange={handleRefImageUpload} disabled={isGenerating} />
              {refImages.length > 0 && (
                <div className="ref-images-list">
                  {refImages.map((img, idx) => (
                    <div key={idx} className="ref-image-item">
                      <img src={img.preview} alt={img.name} />
                      <button className="ref-remove-btn" onClick={() => removeRefImage(idx)} disabled={isGenerating}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Generate Preview Button */}
            <div className="scene-prompt-actions">
              <button
                className="preview-gen-btn"
                onClick={() => generateCompositePreview(scenePrompt)}
                disabled={isGenerating || compositeLoading || !scenePrompt.trim() || !agents.some(a => a.face_image_path)}
              >
                {compositeLoading ? '생성 중...' : '프리뷰 생성'}
              </button>
              {Object.keys(compositePreviews).length > 0 && (
                <button className="bg-remove-btn" onClick={() => { setCompositePreviews({}); }} disabled={isGenerating}>초기화</button>
              )}
            </div>
            {!scenePrompt && <small className="bg-hint">배경을 텍스트로 설명하고, 필요시 참조 이미지를 추가하면 Gemini가 배경을 생성합니다</small>}
          </div>

          {/* Advanced Settings */}
          <details className="advanced-options">
            <summary>고급 설정 (FlashTalk)</summary>
            <div className="form-group">
              <label><strong>프롬프트</strong></label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} disabled={isGenerating} />
            </div>
            <div className="form-group">
              <label><strong>시드</strong></label>
              <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value) || 0)} disabled={isGenerating} />
            </div>
            <div className="form-group">
              <label>
                <input type="checkbox" checked={cpuOffload} onChange={(e) => setCpuOffload(e.target.checked)} disabled={isGenerating} />
                <strong>CPU Offload</strong> (VRAM 절약)
              </label>
            </div>
          </details>

          {/* Generate Button */}
          <button className="generate-button" onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? '생성 중...' : '대화 영상 생성'}
          </button>
        </div>

        {/* Right Panel - Output */}
        <div className="conv-output-panel">
          <h2>생성 결과</h2>

          {/* Progress */}
          {isGenerating && (
            <div className="progress-container">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="progress-info">
                <p className="progress-stage">{stage}</p>
                <p className="progress-message">{statusMessage}</p>
                <p className="progress-percentage">{progress.toFixed(1)}%</p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="error-message">
              <strong>오류:</strong> {error}
            </div>
          )}

          {/* Video Player */}
          {videoUrl && (
            <div className="video-result">
              <h3>대화 영상 생성 완료!</h3>
              <video controls src={videoUrl} className="result-video" />
              <a href={`${videoUrl}?download=true`} className="download-button">다운로드</a>
            </div>
          )}

          {/* Composite Loading */}
          {compositeLoading && !isGenerating && (
            <div className="composite-loading">
              <div className="composite-spinner"></div>
              <p>배경 합성 프리뷰 생성 중... (Gemini)</p>
            </div>
          )}

          {/* Layout Preview or Placeholder */}
          {!isGenerating && !error && !videoUrl && (
            (agents[0].imagePreview || agents[1].imagePreview) ? (
              <div className="layout-preview">
                <h3>레이아웃 미리보기</h3>
                <div
                  className={`preview-frame preview-${layout}`}
                  style={{
                    aspectRatio: `${resolution.split('x')[1]} / ${resolution.split('x')[0]}`,
                  }}
                >
                  {layout === 'split' && (
                    compositePreviews['_full']
                      ? <div className="preview-full-scene">
                          <img src={compositePreviews['_full']} alt="합성 프리뷰" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          <div className="preview-split-names">
                            <span className="preview-name">{agents[0].name}</span>
                            <span className="preview-name">{agents[1].name}</span>
                          </div>
                        </div>
                      : <>
                          <div className="preview-split-left">
                            {agents[0].imagePreview
                              ? <img src={agents[0].imagePreview} alt={agents[0].name} />
                              : <div className="preview-empty">{agents[0].name}</div>}
                            <span className="preview-name">{agents[0].name}</span>
                          </div>
                          <div className="preview-split-right">
                            {agents[1].imagePreview
                              ? <img src={agents[1].imagePreview} alt={agents[1].name} />
                              : <div className="preview-empty">{agents[1].name}</div>}
                            <span className="preview-name">{agents[1].name}</span>
                          </div>
                        </>
                  )}
                  {layout === 'switch' && (
                    <div className="preview-switch-main">
                      {compositePreviews['A']
                        ? <img src={compositePreviews['A']} alt="합성 프리뷰" />
                        : (agents[0].imagePreview || agents[1].imagePreview) && (
                          <img src={agents[0].imagePreview || agents[1].imagePreview} alt="Main speaker" />
                        )}
                      <span className="preview-name">{agents[0].imagePreview ? agents[0].name : agents[1].name}</span>
                    </div>
                  )}
                  {layout === 'pip' && (
                    <div className="preview-pip-container">
                      <div className="preview-pip-main">
                        {compositePreviews['A']
                          ? <img src={compositePreviews['A']} alt={`${agents[0].name} 합성`} />
                          : agents[0].imagePreview
                            ? <img src={agents[0].imagePreview} alt={agents[0].name} />
                            : <div className="preview-empty">{agents[0].name}</div>}
                        <span className="preview-name">{agents[0].name}</span>
                      </div>
                      <div className="preview-pip-sub">
                        {compositePreviews['B']
                          ? <img src={compositePreviews['B']} alt={`${agents[1].name} 합성`} />
                          : agents[1].imagePreview
                            ? <img src={agents[1].imagePreview} alt={agents[1].name} />
                            : <div className="preview-empty">{agents[1].name}</div>}
                      </div>
                    </div>
                  )}
                </div>
                <p className="preview-hint">
                  {resolution} ({resolution.split('x')[1]}x{resolution.split('x')[0]})
                  {Object.keys(compositePreviews).length > 0 && ' — Gemini 합성 프리뷰'}
                </p>
              </div>
            ) : (
              <div className="placeholder">
                <div className="placeholder-icon">
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <p>에이전트 설정과 대화 스크립트를 입력한 후</p>
                <p>대화 영상 생성 버튼을 클릭하세요</p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

export default ConversationGenerator
