import './setup'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadPersianFont } from './i18n'
import './styles.css'

loadPersianFont()

createRoot(document.getElementById('root')!).render(<App />)
