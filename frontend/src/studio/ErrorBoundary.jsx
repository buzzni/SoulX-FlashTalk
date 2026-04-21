// Minimal error boundary — swaps a white screen for a readable diagnostic
// card. Offers a one-click localStorage wipe since the most common crash
// mode is a stale/incompatible saved state carried over from an earlier
// HostStudio schema.
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('HostStudio crashed:', error, info);
    this.setState({ info });
  }
  clearLocalState = () => {
    try {
      localStorage.removeItem('showhost_state');
      localStorage.removeItem('showhost_step');
      localStorage.removeItem('showhost_density');
    } catch (_) { /* ignore */ }
    window.location.reload();
  };
  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div style={{
        padding: 32,
        maxWidth: 720,
        margin: '40px auto',
        fontFamily: 'Pretendard, -apple-system, sans-serif',
        color: '#333',
      }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>HostStudio 실행 중 오류가 발생했어요</h1>
        <p style={{ color: '#666', marginTop: 8 }}>
          저장된 로컬 상태가 새 버전과 호환되지 않거나 네트워크 응답이 예상과 달라서 생긴 문제일 가능성이 높아요.
          아래 버튼을 누르면 저장된 상태를 지우고 처음부터 시작합니다.
        </p>
        <button
          onClick={this.clearLocalState}
          style={{
            marginTop: 16,
            padding: '10px 14px',
            background: '#222',
            color: '#fff',
            border: 0,
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >저장된 상태 지우고 새로고침</button>
        <details style={{ marginTop: 24 }}>
          <summary style={{ cursor: 'pointer', color: '#666', fontSize: 12 }}>기술 상세 보기</summary>
          <pre style={{ marginTop: 8, padding: 12, background: '#f6f6f6', border: '1px solid #ddd', borderRadius: 6, fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
{String(error?.stack || error?.message || error)}
{'\n\n'}
{info?.componentStack || ''}
          </pre>
        </details>
      </div>
    );
  }
}
