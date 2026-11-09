import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { UpdatePrompt } from './components/Pwa';
import { SessionProvider } from './session';
// tailwind.css also pulls in the legacy styles.css, in a layer below Tailwind's utilities.
import './tailwind.css';
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
          <UpdatePrompt />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
