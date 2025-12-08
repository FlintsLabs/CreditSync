export default function Dashboard() {
    return (
        <div className="space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
                    <div className="flex flex-col space-y-1.5">
                        <span className="text-sm font-semibold leading-none tracking-tight text-muted-foreground">Total Active Loans</span>
                        <span className="text-2xl font-bold">12</span>
                    </div>
                </div>
                <div className="rounded-xl border bg-card text-card-foreground shadow p-6">
                    <div className="flex flex-col space-y-1.5">
                        <span className="text-sm font-semibold leading-none tracking-tight text-muted-foreground">Pending Collection (Today)</span>
                        <span className="text-2xl font-bold text-destructive">฿4,200</span>
                    </div>
                </div>
            </div>
        </div>
    )
}
