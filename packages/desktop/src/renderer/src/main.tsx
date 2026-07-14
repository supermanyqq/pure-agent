import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'streamdown/styles.css';
import { App } from './app.js';
import './styles.css';

const ROOT_ELEMENT_ID = 'root';
const ROOT_NOT_FOUND_ERROR = 'Desktop root element was not found.';

const rootElement = document.getElementById(ROOT_ELEMENT_ID);
if (!rootElement) throw new Error(ROOT_NOT_FOUND_ERROR);

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
