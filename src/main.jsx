import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { dismissSplash, watchSplash } from './services/splash'
import './index.css'

// Render immediately beneath the 2.5s launch animation; never wait for IPC.
requestAnimationFrame(() => requestAnimationFrame(dismissSplash))
watchSplash()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
