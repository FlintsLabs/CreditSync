import { useEffect } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { api } from "../../lib/api";

export default function Login() {
    useEffect(() => {
        const token = localStorage.getItem("token");
        if (token) {
            window.location.href = "/dashboard";
        }
    }, []);

    return (
        <div className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-slate-950 font-sans selection:bg-purple-500/30">
            <div className="absolute inset-0 z-0 h-full w-full bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] mask-radial-faded"></div>
            <div className="absolute inset-0 z-0 bg-gradient-to-t from-slate-950 via-transparent to-slate-950/80"></div>
            <div className="absolute -left-[10%] top-[20%] h-[500px] w-[500px] rounded-full bg-purple-600/20 blur-[120px] animate-aurora"></div>
            <div className="absolute -right-[10%] bottom-[20%] h-[500px] w-[500px] rounded-full bg-blue-600/20 blur-[120px] animate-aurora-delayed"></div>

            <div className="group relative z-10 w-full max-w-sm rounded-3xl p-[1px] shadow-2xl transition-all duration-500 hover:shadow-purple-500/10 animate-in fade-in zoom-in-95 slide-in-from-bottom-8">
                <div className="absolute inset-0 -z-10 rounded-3xl bg-gradient-to-br from-white/20 via-white/5 to-white/0 opacity-100 transition-opacity duration-500 group-hover:via-white/10"></div>
                <div className="relative h-full w-full rounded-[23px] bg-black/40 p-8 backdrop-blur-2xl sm:p-10">
                    <div className="flex flex-col items-center text-center">
                        <h1 className="mt-6 bg-gradient-to-br from-white via-slate-200 to-slate-500 bg-clip-text text-5xl font-extrabold tracking-tight text-transparent drop-shadow-sm">
                            CreditSync
                        </h1>
                        <p className="mt-4 text-slate-400">
                            Sign in to manage your lending portfolio.
                        </p>
                    </div>

                    <div className="mt-10 flex justify-center">
                        <GoogleLogin
                            theme="filled_black"
                            size="large"
                            shape="pill"
                            text="continue_with"
                            onSuccess={async (credentialResponse) => {
                                try {
                                    if (!credentialResponse.credential) {
                                        throw new Error("Google did not return an ID token.");
                                    }

                                    const res = await api.post("/auth/google", {
                                        idToken: credentialResponse.credential,
                                    });

                                    localStorage.setItem("token", res.data.accessToken);
                                    localStorage.setItem("user", JSON.stringify(res.data.user));
                                    window.location.href = "/dashboard";
                                } catch (error: any) {
                                    const msg = error.response?.data?.error || error.message || "Unknown error";
                                    alert(`Login failed! ${msg}`);
                                }
                            }}
                            onError={() => {
                                alert("Google sign-in failed.");
                            }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
