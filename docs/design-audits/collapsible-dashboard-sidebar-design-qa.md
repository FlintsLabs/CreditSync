# Compact Rail Dashboard Sidebar Visual QA

## Final result
- passed

## Checks
- expanded: sidebarState=expanded, width=256px, aria-expanded=true, toggleLabel=Collapse sidebar, aria-current=page, collapsedStorage=null, brand class text-lg
- collapsed: sidebarState=collapsed, width=72px, aria-expanded=false, toggleLabel=Expand sidebar, aria-current=page, collapsedStorage=true
- tooltip: "Collapse sidebar" shown on hover/focus before collapse, tooltip dismissed before continuing
- collapse persisted after reload: true
- control reachability: theme=Toggle theme, language=Switch language, account=Open account menu for QA Owner
- account settings reachable: true
- mobile open nav visible=true, mobile close nav visible=true
- screenshots: collapsed, expanded, mobile in docs/design-audits/
