import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: [
      'src/pages/auth/Login.tsx',
      'src/pages/dashboard/PortfolioGraph.tsx',
      'src/pages/dashboard/borrowers/BorrowerEditModal.tsx',
      'src/pages/dashboard/borrowers/BorrowerForm.tsx',
      'src/pages/dashboard/borrowers/BorrowerList.tsx',
      'src/pages/dashboard/funds/FundDetail.tsx',
      'src/pages/dashboard/loans/MatchingWorkspace.tsx',
      'src/pages/dashboard/reconciliation/ReconciliationPage.tsx',
      'src/pages/dashboard/transactions/TransactionList.tsx',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: [
      'src/pages/dashboard/PortfolioGraph.tsx',
      'src/pages/dashboard/loans/LoanList.tsx',
      'src/pages/dashboard/transactions/TransactionList.tsx',
    ],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    files: [
      'src/pages/dashboard/PortfolioGraph.tsx',
      'src/pages/dashboard/borrowers/BorrowerForm.tsx',
      'src/pages/dashboard/borrowers/BorrowerList.tsx',
      'src/pages/dashboard/funds/FundDetail.tsx',
      'src/pages/dashboard/funds/FundList.tsx',
      'src/pages/dashboard/loans/LoanClosingModal.tsx',
      'src/pages/dashboard/loans/MatchingWorkspace.tsx',
      'src/pages/dashboard/reconciliation/ReconciliationPage.tsx',
    ],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
  {
    files: [
      'src/pages/dashboard/funds/FundDetail.tsx',
      'src/pages/dashboard/funds/FundList.tsx',
      'src/pages/dashboard/loans/LoanClosingModal.tsx',
      'src/pages/dashboard/loans/MatchingWorkspace.tsx',
      'src/pages/dashboard/reconciliation/ReconciliationPage.tsx',
    ],
    rules: { 'react-hooks/exhaustive-deps': 'off' },
  },
  {
    files: ['src/components/theme-provider.tsx', 'src/components/ui/badge.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['src/pages/dashboard/PortfolioGraph.tsx'],
    rules: { 'prefer-const': 'off', 'no-empty': 'off' },
  },
])
