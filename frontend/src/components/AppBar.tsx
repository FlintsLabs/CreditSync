
import { Settings, LogOut, User } from "lucide-react";
import { PanelLeftClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "./ui/tooltip";
import { ModeToggle } from "./theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/Button";
import { getStoredUser } from "../lib/session";
import { PREFERENCES_SETTINGS_PATH, PROFILE_SETTINGS_PATH, signOut } from "../lib/account";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type AppBarProps = {
    showAccount?: boolean;
    compact?: boolean;
    sidebarToggle?: {
        collapsed: boolean;
        onToggle: () => void;
        label: string;
    };
};

export type UserAccountMenuProps = {
    buttonClassName?: string;
};

export function UserAccountMenu({ buttonClassName }: UserAccountMenuProps = {}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = getStoredUser();
    const accountLabel = user?.name
        ? t("appbar.accountFor", { name: user.name })
        : t("appbar.account", "Open account menu");

    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button
                aria-label={accountLabel}
                variant="ghost"
                className={`relative h-9 w-9 rounded-full ${buttonClassName ?? ""}`}
            >
                <Avatar className="h-8 w-8">
                    <AvatarImage src={user?.picture} alt={user?.name} />
                    <AvatarFallback>{user?.name?.charAt(0) || "U"}</AvatarFallback>
                </Avatar>
            </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{user?.name}</p>
                    <p className="text-xs leading-none text-muted-foreground">{user?.email}</p>
                </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => navigate(PROFILE_SETTINGS_PATH)}>
                    <User className="mr-2 h-4 w-4" />
                    <span>{t("appbar.profile", "Profile")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate(PREFERENCES_SETTINGS_PATH)}>
                    <Settings className="mr-2 h-4 w-4" />
                    <span>{t("appbar.settings", "Settings")}</span>
                </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut(navigate)} className="text-destructive focus:text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                <span>{t("appbar.logout", "Log out")}</span>
            </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>;
}

export default function AppBar({
    showAccount = true,
    compact = false,
    sidebarToggle,
}: AppBarProps) {
    const compactControlClass = compact ? "h-8 w-8" : "h-10 w-10";
    const brand = compact ? (
        <img
            aria-hidden="true"
            className="h-6 w-6 shrink-0 rounded-md"
            src="/favicon.svg"
            alt=""
        />
    ) : (
        <h1 className="text-lg font-bold ml-2">CreditSync</h1>
    );

    const sidebarToggleButton = sidebarToggle && (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        aria-label={sidebarToggle.label}
                        aria-expanded={!sidebarToggle.collapsed}
                        variant="ghost"
                        size="icon"
                        onClick={sidebarToggle.onToggle}
                        className={compactControlClass}
                    >
                        {sidebarToggle.collapsed ? (
                            <PanelRightOpen className="h-4 w-4" />
                        ) : (
                            <PanelLeftClose className="h-4 w-4" />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{sidebarToggle.label}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );

    return (
        <div className={`flex h-16 items-center border-b ${compact ? "px-1" : "px-4"} ${compact ? "justify-start" : "justify-between"}`}>
            {compact ? (
                <div className="grid w-full grid-cols-2 gap-1">
                    <div className="flex h-8 items-center justify-center">{brand}</div>
                    <div className="flex h-8 items-center justify-center">{sidebarToggleButton}</div>
                    <div className="flex h-8 items-center justify-center">
                        <ModeToggle compactButtonClass={compactControlClass} />
                    </div>
                    <div className="flex h-8 items-center justify-center">
                        {showAccount ? <UserAccountMenu buttonClassName={compactControlClass} /> : null}
                    </div>
                </div>
            ) : (
                <>
                    <div className="min-w-0 flex-1">
                        <div className="whitespace-nowrap">{brand}</div>
                    </div>
                    <div className="flex items-center gap-0">
                        <ModeToggle />
                        {sidebarToggleButton}
                        {showAccount && <UserAccountMenu />}
                    </div>
                </>
            )}
        </div>
    );
}
