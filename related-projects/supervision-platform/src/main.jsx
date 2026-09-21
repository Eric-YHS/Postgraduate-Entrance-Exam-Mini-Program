import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('应用渲染失败:', error, info);
  }
  render() {
    if (this.state.error) {
      return <main style={{maxWidth:720, margin:'80px auto', padding:28, fontFamily:'Arial,sans-serif', color:'#244d43', background:'#fff', border:'1px solid #dce9e3', borderRadius:12, boxShadow:'0 12px 35px rgba(24,72,60,.08)'}}><h1>页面启动失败</h1><p>应用发生了运行错误。请关闭启动窗口后重新启动；如果仍然出现，请把下面的错误内容发给我。</p><pre style={{whiteSpace:'pre-wrap', color:'#a44b45', background:'#fff5f3', padding:12, borderRadius:8}}>{String(this.state.error?.stack || this.state.error)}</pre></main>;
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
createRoot(rootElement).render(
  <AppErrorBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </AppErrorBoundary>,
);
