import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import CallPage from './pages/CallPage';
import DashboardPage from './pages/DashboardPage';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { PhoneCall, AlertTriangle } from 'lucide-react';

function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="glass rounded-3xl p-12 text-center max-w-md w-full fade-up">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mx-auto mb-5">
          <AlertTriangle className="w-7 h-7 text-amber-500" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-slate-800">Page not found</h1>
        <p className="text-slate-500 mt-2 mb-7 text-sm leading-relaxed">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link
          to="/"
          className="btn-shine inline-flex items-center gap-2 bg-gradient-to-br from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white px-6 py-2.5 rounded-xl font-medium transition-all shadow-sm"
        >
          <PhoneCall className="w-4 h-4" aria-hidden="true" />
          Back to home
        </Link>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<ErrorBoundary><CallPage /></ErrorBoundary>} />
          <Route path="/dashboard" element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="/dashboard/:callId" element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

