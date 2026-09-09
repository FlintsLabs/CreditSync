export const SETTINGS_PATH = "/settings";
export const PROFILE_SETTINGS_PATH = `${SETTINGS_PATH}#profile`;
export const PREFERENCES_SETTINGS_PATH = `${SETTINGS_PATH}#preferences`;

export function signOut(navigate: (destination: string) => void) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    navigate("/login");
}
