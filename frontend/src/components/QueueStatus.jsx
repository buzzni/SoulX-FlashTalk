import { useState, useEffect, useCallback } from 'react'
import './QueueStatus.css'

const API_BASE = ''

function QueueStatus() {
  const [queueData, setQueueData] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(null)

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/queue`)
      if (!res.ok) throw new Error('Failed to fetch queue')
      const data = await res.json()
      setQueueData(data)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    fetchQueue()
    const interval = setInterval(fetchQueue, 5000)
    return () => clearInterval(interval)
  }, [fetchQueue])

  const handleCancel = async (taskId) => {
    try {
      const res = await fetch(`${API_BASE}/api/queue/${taskId}`, { method: 'DELETE' })
      if (res.ok) {
        fetchQueue()
      }
    } catch (err) {
      console.error('Failed to cancel task:', err)
    }
  }

  if (!queueData) return null

  const totalActive = queueData.total_running + queueData.total_pending

  const formatTime = (isoStr) => {
    if (!isoStr) return '-'
    const d = new Date(isoStr)
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const typeLabel = (type) => {
    return type === 'generate' ? 'Single' : 'Multi-Agent'
  }

  const statusLabel = (status) => {
    const map = {
      pending: '대기 중',
      running: '실행 중',
      completed: '완료',
      error: '오류',
      cancelled: '취소됨',
    }
    return map[status] || status
  }

  return (
    <div className="queue-status">
      <button
        className={`queue-badge ${totalActive > 0 ? 'active' : ''}`}
        onClick={() => setExpanded(!expanded)}
        title="작업 큐 상태"
      >
        <span className="queue-icon">&#9776;</span>
        {totalActive > 0 && <span className="queue-count">{totalActive}</span>}
        <span className="queue-label">큐</span>
      </button>

      {expanded && (
        <div className="queue-panel">
          <div className="queue-panel-header">
            <h3>작업 큐</h3>
            <button className="queue-close" onClick={() => setExpanded(false)}>&times;</button>
          </div>

          {error && <div className="queue-error">{error}</div>}

          {/* Running */}
          {queueData.running.length > 0 && (
            <div className="queue-section">
              <h4 className="queue-section-title running">실행 중</h4>
              {queueData.running.map((task) => (
                <div key={task.task_id} className="queue-item running">
                  <div className="queue-item-info">
                    <span className="queue-item-type">{typeLabel(task.type)}</span>
                    <span className="queue-item-label">{task.label || task.task_id.slice(0, 8)}</span>
                  </div>
                  <div className="queue-item-meta">
                    <span className="queue-item-time">{formatTime(task.started_at)}</span>
                    <span className="queue-item-status running">{statusLabel(task.status)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pending */}
          {queueData.pending.length > 0 && (
            <div className="queue-section">
              <h4 className="queue-section-title pending">대기 중 ({queueData.pending.length})</h4>
              {queueData.pending.map((task, idx) => (
                <div key={task.task_id} className="queue-item pending">
                  <div className="queue-item-info">
                    <span className="queue-item-position">#{idx + 1}</span>
                    <span className="queue-item-type">{typeLabel(task.type)}</span>
                    <span className="queue-item-label">{task.label || task.task_id.slice(0, 8)}</span>
                  </div>
                  <div className="queue-item-meta">
                    <span className="queue-item-time">{formatTime(task.created_at)}</span>
                    <button
                      className="queue-cancel-btn"
                      onClick={() => handleCancel(task.task_id)}
                      title="작업 취소"
                    >
                      취소
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent */}
          {queueData.recent.length > 0 && (
            <div className="queue-section">
              <h4 className="queue-section-title recent">최근 완료</h4>
              {queueData.recent.slice(0, 5).map((task) => (
                <div key={task.task_id} className={`queue-item ${task.status}`}>
                  <div className="queue-item-info">
                    <span className="queue-item-type">{typeLabel(task.type)}</span>
                    <span className="queue-item-label">{task.label || task.task_id.slice(0, 8)}</span>
                  </div>
                  <div className="queue-item-meta">
                    <span className="queue-item-time">{formatTime(task.completed_at)}</span>
                    <span className={`queue-item-status ${task.status}`}>{statusLabel(task.status)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalActive === 0 && queueData.recent.length === 0 && (
            <div className="queue-empty">큐가 비어있습니다</div>
          )}
        </div>
      )}
    </div>
  )
}

export default QueueStatus
