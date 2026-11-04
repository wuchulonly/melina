// 全局样式先进来，各页面自己的样式在后面，同样的选择器页面的说了算
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('index.html 里少了 #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
