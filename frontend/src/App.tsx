import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import "./lib/i18n"; // Initialize i18n
import Login from "./pages/auth/Login";
import DashboardLayout from "./layouts/DashboardLayout";
import Dashboard from "./pages/dashboard/Dashboard";
import FundList from "./pages/dashboard/funds/FundList";
import FundDetail from "./pages/dashboard/funds/FundDetail";
import BorrowerList from "./pages/dashboard/borrowers/BorrowerList";
import BorrowerForm from "./pages/dashboard/borrowers/BorrowerForm";
import BorrowerDetail from "./pages/dashboard/borrowers/BorrowerDetail";
import LoanWizard from "./pages/dashboard/loans/LoanWizard";
import LoanList from "./pages/dashboard/loans/LoanList";
import LoanDetail from "./pages/dashboard/loans/LoanDetail";
import MatchingWorkspace from "./pages/dashboard/loans/MatchingWorkspace";
import TransactionList from "./pages/dashboard/transactions/TransactionList";
import TransactionForm from "./pages/dashboard/transactions/TransactionForm";
import ReconciliationPage from "./pages/dashboard/reconciliation/ReconciliationPage";
import PaymentInbox from "./pages/dashboard/payments/PaymentInbox";
import AccountPreferencesPage from "./pages/dashboard/settings/AccountPreferencesPage";
import LandingPage from "./pages/LandingPage";
import ProtectedRoute from "./components/ProtectedRoute";
import { SETTINGS_PATH } from "./lib/account";
import './index.css'

function App() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  if (!clientId) {
    return (
      <div className="flex h-screen items-center justify-center bg-destructive/10 p-4 text-destructive">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Missing Configuration</h1>
          <p className="mt-2">Google Client ID is missing.</p>
          <p className="text-sm">Please create <code>frontend/.env</code> and add <code>VITE_GOOGLE_CLIENT_ID=...</code></p>
        </div>
      </div>
    )
  }

  return (
    <GoogleOAuthProvider clientId={clientId}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />

          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<DashboardLayout />}>
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="funds" element={<FundList />} />
              <Route path="funds/:id" element={<FundDetail />} />
              <Route path="borrowers" element={<BorrowerList />} />
              <Route path="borrowers/new" element={<BorrowerForm />} />
              <Route path="borrowers/:id" element={<BorrowerDetail />} />
              <Route path="loans" element={<LoanList />} />
              <Route path="loans/:id" element={<LoanDetail />} />
              <Route path="loans/new" element={<LoanWizard />} />
              <Route path="matching" element={<MatchingWorkspace />} />
              <Route path="transactions" element={<TransactionList />} />
              <Route path="transactions/new" element={<TransactionForm />} />
              <Route path="payments" element={<PaymentInbox />} />
              <Route path="reconciliation" element={<ReconciliationPage />} />
              <Route path="settings" element={<AccountPreferencesPage />} />
              <Route path="dashboard/settings" element={<Navigate to={SETTINGS_PATH} replace />} />
            </Route>
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </GoogleOAuthProvider>
  );
}

export default App;
