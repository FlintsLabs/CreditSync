import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Wallet, FileText, Settings, Activity, Menu, X, ArrowRightLeft, ScanSearch, Inbox, HandCoins } from "lucide-react";
import { cn } from "../lib/utils";
import AppBar, { type AppBarProps } from "../components/AppBar";
import { UserAccountMenu } from "../components/AppBar";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/Button";
import { getStoredUser, isTenantAdminUser } from "../lib/session";
import { SETTINGS_PATH } from "../lib/account";
import { useSidebarCollapsed } from "../hooks/useSidebarCollapsed";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "../components/ui/tooltip";

export default function DashboardLayout() {
    const location = useLocation();
    const { t } = useTranslation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const currentUser = getStoredUser();
    const isTenantAdmin = isTenantAdminUser(currentUser);
    const [isSidebarCollapsed, toggleSidebar] = useSidebarCollapsed();

    const sidebarToggle: AppBarProps["sidebarToggle"] = {
        collapsed: isSidebarCollapsed,
        onToggle: toggleSidebar,
        label: t(isSidebarCollapsed ? "nav.expandSidebar" : "nav.collapseSidebar"),
    };

    const navigation = [
        ...(isTenantAdmin ? [{ name: t("nav.dashboard", "Dashboard"), href: "/dashboard", icon: LayoutDashboard }] : []),
        { name: t("dashboard.borrowers", "Borrowers"), href: "/borrowers", icon: Users },
        { name: t("dashboard.loans", "Loans"), href: "/loans", icon: FileText },
        { name: t("nav.transactions", "Transactions"), href: "/transactions", icon: Activity },
        { name: t("nav.payments"), href: "/payments", icon: Inbox },
        ...(isTenantAdmin ? [
            { name: t("nav.matching", "Matching"), href: "/matching", icon: ArrowRightLeft },
            { name: t("nav.reconciliation", "Reconciliation"), href: "/reconciliation", icon: ScanSearch },
            { name: t("nav.intermediaries", "Intermediaries"), href: "/intermediaries", icon: HandCoins },
            { name: t("dashboard.funds", "Funds"), href: "/funds", icon: Wallet },
        ] : []),
        { name: t("nav.settings", "Settings"), href: SETTINGS_PATH, icon: Settings },
    ];

    return (
        <div className="flex min-h-screen bg-background text-foreground transition-colors duration-300">
            <aside
                data-testid="desktop-sidebar"
                data-sidebar-state={isSidebarCollapsed ? "collapsed" : "expanded"}
                className={cn(
                    "sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r bg-card transition-[width] duration-200 motion-reduce:transition-none md:flex",
                    isSidebarCollapsed ? "w-[72px]" : "w-64",
                )}
            >
                <AppBar compact={isSidebarCollapsed} sidebarToggle={sidebarToggle} />

                <div className="flex flex-1 flex-col gap-1 p-4">
                    <TooltipProvider>
                        {navigation.map((item) => {
                            const Icon = item.icon;
                            const isActive = location.pathname === item.href || (item.href === "/intermediaries" && location.pathname.startsWith("/intermediaries/"));
                            const link = (
                                <Link
                                    key={item.href}
                                    to={item.href}
                                    aria-label={item.name}
                                    aria-current={isActive ? "page" : undefined}
                                    className={cn(
                                        "flex items-center gap-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                        isSidebarCollapsed ? "size-10 justify-center p-0 mx-auto" : "px-3 py-2",
                                        isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                                    )}
                                >
                                    <Icon className="h-4 w-4 shrink-0" />
                                    {!isSidebarCollapsed && item.name}
                                </Link>
                            );

                            if (!isSidebarCollapsed) {
                                return <div key={item.href}>{link}</div>;
                            }

                            return (
                                <Tooltip key={item.href}>
                                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                                    <TooltipContent side="right">{item.name}</TooltipContent>
                                </Tooltip>
                            );
                        })}
                    </TooltipProvider>
                </div>

                <div data-testid="sidebar-account-footer" className="mt-auto border-t p-4">
                    <div className={cn("flex items-center", isSidebarCollapsed ? "justify-center" : "justify-start")}>
                        <UserAccountMenu dropdownAlign="start" />
                    </div>
                </div>
            </aside>

            {/* Main Content Area */}
            <div className="flex flex-1 flex-col min-w-0">
                {/* Mobile Header (Visible only on Mobile) */}
                <header data-testid="mobile-header" className="sticky top-0 z-30 flex h-16 items-center border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
                    <Button
                        aria-label={isMobileMenuOpen ? t("nav.closeNavigation") : t("nav.openNavigation")}
                        variant="ghost"
                        size="icon"
                        className="-ml-2 mr-2"
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                    >
                        {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                    </Button>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        <img aria-hidden="true" className="h-7 w-7 shrink-0 rounded-md" src="/favicon.svg" />
                        <span className="truncate text-lg font-bold">CreditSync</span>
                    </div>
                </header>

                {/* Mobile Sidebar Overlay (Slide-in) */}
                {isMobileMenuOpen && (
                    <div className="fixed inset-0 z-40 flex md:hidden">
                        {/* Backdrop */}
                        <div
                            className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
                            onClick={() => setIsMobileMenuOpen(false)}
                        />

                        {/* Sidebar Panel */}
                        <div data-testid="mobile-sidebar" className="relative flex w-[80%] max-w-xs flex-col bg-card shadow-2xl animate-in slide-in-from-left duration-300">
                            <div className="p-4 border-b">
                                <AppBar />
                            </div>

                            <div className="flex-1 overflow-y-auto p-4">
                                <nav className="flex flex-col gap-1">
                                    {navigation.map((item) => {
                                        const Icon = item.icon;
                                        const isActive = location.pathname === item.href || (item.href === "/intermediaries" && location.pathname.startsWith("/intermediaries/"));
                                        return (
                                            <Link
                                                key={item.href}
                                                to={item.href}
                                                onClick={() => setIsMobileMenuOpen(false)}
                                                className={cn(
                                                    "flex items-center gap-3 rounded-md px-3 py-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                                                )}
                                            >
                                                <Icon className="h-5 w-5" />
                                                {item.name}
                                            </Link>
                                        );
                                    })}
                                </nav>
                            </div>

                            <div data-testid="sidebar-account-footer" className="border-t p-4">
                                <UserAccountMenu dropdownAlign="start" />
                            </div>
                        </div>
                    </div>
                )}

                {/* Page Content */}
                <main className="flex-1 overflow-x-hidden p-4 md:p-8">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
