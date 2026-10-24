import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
// Ark UI 设计层必须**在 styles.css 之后**：它靠后者覆盖同优先级规则。
// 顺序反了整层失效，而且不报错。
import './ark.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
