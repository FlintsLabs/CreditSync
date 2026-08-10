
import { Settings, LogOut, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ModeToggle } from "./theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/Button";
import { getStoredUser } from "../lib/session";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function UserAccountMenu() {
    const { t } = useTranslation();
    const user = getStoredUser();

    const handleLogout = () => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/login";
    };

    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button aria-label={t("appbar.account", "Open account menu")} variant="ghost" className="relative h-9 w-9 rounded-full">
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
                <DropdownMenuItem>
                    <User className="mr-2 h-4 w-4" />
                    <span>{t("appbar.profile", "Profile")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4" />
                    <span>{t("appbar.settings", "Settings")}</span>
                </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                <span>{t("appbar.logout", "Log out")}</span>
            </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>;
}

export default function AppBar({ showAccount = true }: { showAccount?: boolean }) {
    return (
        <div className="flex h-16 items-center justify-between border-b px-4">
            <h1 className="text-xl font-bold ml-2">CreditSync</h1>
            <div className="flex items-center gap-2">
                <ModeToggle />
                {showAccount && <UserAccountMenu />}
            </div>
        </div>
    );
}
