import { useState, useEffect, useRef } from 'react'
import './VideoGenerator.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8001'

function VideoGenerator() {
  // Audio source mode: "upload" or "elevenlabs"
  const [audioSource, setAudioSource] = useState('upload')

  // Host image
  const [hostImagePath, setHostImagePath] = useState(null)
  const [hostImagePreview, setHostImagePreview] = useState(null)
  const [hostImageFile, setHostImageFile] = useState(null)

  // Audio upload
  const [audioPath, setAudioPath] = useState(null)
  const [audioFile, setAudioFile] = useState(null)

  // Reference audio (for ElevenLabs clone)
  const [refAudioPath, setRefAudioPath] = useState(null)
  const [refAudioFile, setRefAudioFile] = useState(null)

  // ElevenLabs
  const [scriptText, setScriptText] = useState('')
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = useState('')
  const [voicesLoading, setVoicesLoading] = useState(false)
  const [stability, setStability] = useState(0.5)
  const [similarityBoost, setSimilarityBoost] = useState(0.75)
  const [style, setStyle] = useState(0.0)
  const [cloneName, setCloneName] = useState('')
  const [isCloning, setIsCloning] = useState(false)

  // FlashTalk params
  const [prompt, setPrompt] = useState('')
  const [seed, setSeed] = useState(9999)
  const [cpuOffload, setCpuOffload] = useState(true)
  const [resolution, setResolution] = useState('1280x720')

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

  // History
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])

  const eventSourceRef = useRef(null)

  // Load config on mount
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/config`)
      .then(r => r.json())
      .then(data => {
        setAppConfig(data)
        setPrompt(data.default_prompt || '')
        setSeed(data.default_seed || 9999)
        setCpuOffload(data.cpu_offload ?? true)
        if (data.default_host_image) {
          setHostImagePreview(`${API_BASE_URL}/static/${data.default_host_image}`)
        }
      })
      .catch(err => console.error('Config load failed:', err))

    loadHistory()
  }, [])

  const loadHistory = async () => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/history`)
      const data = await r.json()
      setHistory(data.videos || [])
    } catch (err) {
      console.error('History load failed:', err)
    }
  }

  // Load ElevenLabs voices
  const loadVoices = async () => {
    setVoicesLoading(true)
    try {
      const r = await fetch(`${API_BASE_URL}/api/elevenlabs/voices`)
      const data = await r.json()
      setVoices(data.voices || [])
      if (data.voices?.length > 0 && !selectedVoice) {
        setSelectedVoice(data.voices[0].voice_id)
      }
    } catch (err) {
      console.error('Failed to load voices:', err)
      setError('ElevenLabs 음성 목록 로드 실패. API 키를 확인하세요.')
    } finally {
      setVoicesLoading(false)
    }
  }

  // Load voices when switching to elevenlabs mode
  useEffect(() => {
    if (audioSource === 'elevenlabs' && voices.length === 0) {
      loadVoices()
    }
  }, [audioSource])

  // Handle host image upload
  const handleHostImageChange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setHostImageFile(file)
    setHostImagePreview(URL.createObjectURL(file))

    const formData = new FormData()
    formData.append('file', file)
    try {
      const r = await fetch(`${API_BASE_URL}/api/upload/host-image`, { method: 'POST', body: formData })
      const data = await r.json()
      setHostImagePath(data.path)
    } catch (err) {
      setError('이미지 업로드 실패')
    }
  }

  // Handle audio upload
  const handleAudioChange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setAudioFile(file)

    const formData = new FormData()
    formData.append('file', file)
    try {
      const r = await fetch(`${API_BASE_URL}/api/upload/audio`, { method: 'POST', body: formData })
      const data = await r.json()
      setAudioPath(data.path)
    } catch (err) {
      setError('오디오 업로드 실패')
    }
  }

  // Handle reference audio upload (for voice cloning)
  const handleRefAudioChange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setRefAudioFile(file)

    const formData = new FormData()
    formData.append('file', file)
    try {
      const r = await fetch(`${API_BASE_URL}/api/upload/reference-audio`, { method: 'POST', body: formData })
      const data = await r.json()
      setRefAudioPath(data.path)
    } catch (err) {
      setError('참조 음성 업로드 실패')
    }
  }

  // Clone voice
  const handleCloneVoice = async () => {
    if (!refAudioFile || !cloneName.trim()) {
      setError('음성 이름과 참조 오디오가 필요합니다')
      return
    }

    setIsCloning(true)
    setError(null)

    const formData = new FormData()
    formData.append('name', cloneName)
    formData.append('file', refAudioFile)

    try {
      const r = await fetch(`${API_BASE_URL}/api/elevenlabs/clone-voice`, { method: 'POST', body: formData })
      if (!r.ok) {
        const err = await r.json()
        throw new Error(err.detail || 'Clone failed')
      }
      const data = await r.json()
      // Reload voices and select the new one
      await loadVoices()
      setSelectedVoice(data.voice_id)
      setCloneName('')
    } catch (err) {
      setError(`음성 클론 실패: ${err.message}`)
    } finally {
      setIsCloning(false)
    }
  }

  // Generate video
  const handleGenerate = async () => {
    if (audioSource === 'upload' && !audioPath && !appConfig?.default_audio) {
      setError('오디오 파일을 업로드하세요')
      return
    }
    if (audioSource === 'elevenlabs' && !scriptText.trim()) {
      setError('텍스트를 입력하세요')
      return
    }
    if (audioSource === 'elevenlabs' && !selectedVoice) {
      setError('음성을 선택하세요')
      return
    }

    setIsGenerating(true)
    setError(null)
    setVideoUrl(null)
    setProgress(0)
    setStage('')
    setStatusMessage('')

    const formData = new FormData()
    formData.append('audio_source', audioSource)
    formData.append('prompt', prompt)
    formData.append('seed', seed)
    formData.append('cpu_offload', cpuOffload)
    formData.append('resolution', resolution)

    if (hostImagePath) formData.append('host_image_path', hostImagePath)

    if (audioSource === 'upload') {
      if (audioPath) formData.append('audio_path', audioPath)
    } else {
      formData.append('script_text', scriptText)
      formData.append('voice_id', selectedVoice)
      formData.append('stability', stability)
      formData.append('similarity_boost', similarityBoost)
      formData.append('style', style)
    }

    try {
      const r = await fetch(`${API_BASE_URL}/api/generate`, { method: 'POST', body: formData })
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
          loadHistory()
        } else if (u.stage === 'error') {
          setIsGenerating(false)
          setError(u.message)
          es.close()
        }
      }

      es.onerror = () => {
        es.close()
      }
    } catch (err) {
      setError(err.message || '비디오 생성 실패')
      setIsGenerating(false)
    }
  }

  useEffect(() => {
    return () => { eventSourceRef.current?.close() }
  }, [])

  return (
    <div className="video-generator">
      <div className="generator-container">
        {/* Left Panel */}
        <div className="input-panel">
          <h2>입력 설정</h2>

          {/* Host Image */}
          <div className="form-group">
            <label><strong>쇼호스트 이미지</strong></label>
            <input type="file" accept="image/*" onChange={handleHostImageChange} disabled={isGenerating} />
            {hostImagePreview && (
              <div className="image-preview">
                <img src={hostImagePreview} alt="Host" />
              </div>
            )}
            {hostImageFile && <small>업로드됨: {hostImageFile.name}</small>}
            {!hostImageFile && <small>기본값: examples/man.png</small>}
          </div>

          {/* Audio Source Selector */}
          <div className="form-group">
            <label><strong>오디오 소스</strong></label>
            <div className="radio-group">
              <label className={`radio-option ${audioSource === 'upload' ? 'active' : ''}`}>
                <input type="radio" name="audioSource" value="upload" checked={audioSource === 'upload'} onChange={() => setAudioSource('upload')} disabled={isGenerating} />
                오디오 파일 업로드
              </label>
              <label className={`radio-option ${audioSource === 'elevenlabs' ? 'active' : ''}`}>
                <input type="radio" name="audioSource" value="elevenlabs" checked={audioSource === 'elevenlabs'} onChange={() => setAudioSource('elevenlabs')} disabled={isGenerating} />
                ElevenLabs TTS
              </label>
            </div>
          </div>

          {/* Audio Upload Mode */}
          {audioSource === 'upload' && (
            <div className="form-group">
              <label><strong>오디오 파일</strong></label>
              <input type="file" accept="audio/*" onChange={handleAudioChange} disabled={isGenerating} />
              {audioFile && <small>선택됨: {audioFile.name}</small>}
              {!audioFile && <small>기본값: examples/cantonese_16k.wav</small>}
            </div>
          )}

          {/* ElevenLabs Mode */}
          {audioSource === 'elevenlabs' && (
            <div className="elevenlabs-section">
              {/* Script Text */}
              <div className="form-group">
                <label><strong>텍스트 (TTS)</strong><span className="required">*</span></label>
                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder="말할 텍스트를 입력하세요..."
                  rows={4}
                  disabled={isGenerating}
                />
                <small>{scriptText.length} 글자</small>
              </div>

              {/* Voice Selection */}
              <div className="form-group">
                <label>
                  <strong>음성 선택</strong>
                  <button className="refresh-btn" onClick={loadVoices} disabled={voicesLoading}>
                    {voicesLoading ? '...' : '새로고침'}
                  </button>
                </label>
                <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} disabled={isGenerating || voicesLoading}>
                  <option value="">음성을 선택하세요</option>
                  {voices.map(v => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name} {v.category ? `(${v.category})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Voice Settings */}
              <div className="form-group">
                <label><strong>안정성</strong> <span className="param-value">({stability})</span></label>
                <input type="range" min="0" max="1" step="0.05" value={stability} onChange={(e) => setStability(parseFloat(e.target.value))} disabled={isGenerating} />
              </div>

              <div className="form-group">
                <label><strong>유사도</strong> <span className="param-value">({similarityBoost})</span></label>
                <input type="range" min="0" max="1" step="0.05" value={similarityBoost} onChange={(e) => setSimilarityBoost(parseFloat(e.target.value))} disabled={isGenerating} />
              </div>

              <div className="form-group">
                <label><strong>스타일</strong> <span className="param-value">({style})</span></label>
                <input type="range" min="0" max="1" step="0.05" value={style} onChange={(e) => setStyle(parseFloat(e.target.value))} disabled={isGenerating} />
              </div>

              {/* Voice Cloning */}
              <details className="clone-section">
                <summary>음성 클론 (참조 음성으로 새 음성 생성)</summary>
                <div className="form-group">
                  <label><strong>참조 음성 파일</strong></label>
                  <input type="file" accept="audio/*" onChange={handleRefAudioChange} disabled={isGenerating || isCloning} />
                  {refAudioFile && <small>선택됨: {refAudioFile.name}</small>}
                </div>
                <div className="form-group">
                  <label><strong>음성 이름</strong></label>
                  <input type="text" value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="클론할 음성 이름..." disabled={isGenerating || isCloning} />
                </div>
                <button className="clone-button" onClick={handleCloneVoice} disabled={isGenerating || isCloning || !refAudioFile || !cloneName.trim()}>
                  {isCloning ? '클론 중...' : '음성 클론'}
                </button>
              </details>
            </div>
          )}

          {/* Resolution */}
          <div className="form-group">
            <label><strong>해상도</strong></label>
            <div className="resolution-grid">
              {[
                { value: '768x448', label: '448p', desc: '768x448 (기본, 빠름)' },
                { value: '1280x720', label: '720p', desc: '1280x720 (HD)' },
                { value: '832x480', label: '480p', desc: '832x480 (중간)' },
                { value: '1920x1080', label: '1080p', desc: '1920x1080 (Full HD, 느림)' },
              ].map(r => (
                <label key={r.value} className={`resolution-option ${resolution === r.value ? 'active' : ''}`}>
                  <input type="radio" name="resolution" value={r.value} checked={resolution === r.value} onChange={() => setResolution(r.value)} disabled={isGenerating} />
                  <span className="resolution-label">{r.label}</span>
                  <span className="resolution-desc">{r.desc}</span>
                </label>
              ))}
            </div>
          </div>

          {/* FlashTalk Settings */}
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
                <strong>CPU Offload</strong> (VRAM 절약: 64GB → 40GB)
              </label>
            </div>
          </details>

          {/* Generate Button */}
          <button className="generate-button" onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? '생성 중...' : '비디오 생성'}
          </button>
        </div>

        {/* Right Panel */}
        <div className="output-panel">
          <div className="output-panel-header">
            <h2>생성 결과</h2>
            <button className="history-toggle-button" onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? '입력폼' : '히스토리'}
            </button>
          </div>

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
              <h3>생성 완료!</h3>
              <video controls src={videoUrl} className="result-video" />
              <a href={`${videoUrl}?download=true`} className="download-button">다운로드</a>
            </div>
          )}

          {/* Placeholder */}
          {!showHistory && !isGenerating && !error && !videoUrl && (
            <div className="placeholder">
              <p>왼쪽에서 설정 후</p>
              <p>비디오 생성 버튼을 클릭하세요</p>
            </div>
          )}

          {/* History */}
          {showHistory && (
            <div className="history-view">
              <h3>히스토리 ({history.length})</h3>
              {history.length === 0 ? (
                <div className="placeholder"><p>아직 생성된 비디오 없음</p></div>
              ) : (
                <div className="history-list">
                  {history.map((v) => (
                    <div key={v.task_id} className="history-item">
                      <div className="history-item-header">
                        <span className="history-item-date">{new Date(v.timestamp).toLocaleString('ko-KR')}</span>
                        <span className="history-item-badge">{v.audio_source}</span>
                      </div>
                      <div className="history-item-body">
                        <p>{v.script_text || v.host_image}</p>
                        <div className="history-item-meta">
                          <span>Host: {v.host_image}</span>
                          <span>{(v.file_size / 1024 / 1024).toFixed(2)} MB</span>
                          {v.generation_time && <span>{v.generation_time}s</span>}
                        </div>
                      </div>
                      <div className="history-item-actions">
                        <a href={`${API_BASE_URL}${v.video_url}`} target="_blank" rel="noopener noreferrer" className="history-btn play">재생</a>
                        <a href={`${API_BASE_URL}${v.video_url}?download=true`} className="history-btn dl">다운로드</a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default VideoGenerator
