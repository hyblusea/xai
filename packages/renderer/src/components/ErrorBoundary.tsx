import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: 24,
          color: '#e8e0d8',
          background: '#0e0f14',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#ef4444' }}>
            组件渲染出错
          </div>
          <div style={{ fontSize: 12, color: '#7a7570', marginBottom: 12, textAlign: 'center', maxWidth: 400 }}>
            {this.state.error?.message || '未知错误'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px',
              fontSize: 12,
              border: '1px solid #3a3a3a',
              borderRadius: 4,
              background: '#1a1a1a',
              color: '#e8e0d8',
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}