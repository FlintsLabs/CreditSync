import { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Plus, Wallet, Building2, Trash2 } from "lucide-react";
import { Input } from "../../../components/ui/Input";

interface BankProfile {
    id: number;
    name: string;
    type: string;
    creditLimit: string | null;
}

export default function FundList() {
    const [funds, setFunds] = useState<BankProfile[]>([]);
    const [loading, setLoading] = useState(true);

    // New Fund Form State
    const [isAdding, setIsAdding] = useState(false);
    const [newName, setNewName] = useState("");
    const [newLimit, setNewLimit] = useState("");
    const [newType, setNewType] = useState("bank");

    useEffect(() => {
        fetchFunds();
    }, []);

    const fetchFunds = async () => {
        try {
            const res = await axios.get("http://localhost:3000/bank-profiles");
            setFunds(res.data);
        } catch (error) {
            console.error("Failed to fetch funds", error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!newName) return;
        try {
            await axios.post("http://localhost:3000/bank-profiles", {
                name: newName,
                type: newType,
                creditLimit: newLimit || "0",
            });
            setIsAdding(false);
            setNewName("");
            setNewLimit("");
            fetchFunds();
        } catch (error) {
            console.error("Failed to create fund", error);
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm("Are you sure?")) return;
        try {
            await axios.delete(`http://localhost:3000/bank-profiles/${id}`);
            fetchFunds();
        } catch (error) {
            console.error("Failed to delete", error);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Sources of Funds</h2>
                    <p className="text-muted-foreground">Manage your bank accounts and credit lines.</p>
                </div>
                <Button onClick={() => setIsAdding(!isAdding)}>
                    <Plus className="mr-2 h-4 w-4" /> Add Source
                </Button>
            </div>

            {isAdding && (
                <Card className="border-dashed">
                    <CardHeader>
                        <CardTitle className="text-lg">New Source of Fund</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex gap-4 items-end">
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">Bank/Source Name</label>
                                <Input placeholder="e.g. SCB Speedy Cash" value={newName} onChange={e => setNewName(e.target.value)} />
                            </div>
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">Type</label>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={newType}
                                    onChange={e => setNewType(e.target.value)}
                                >
                                    <option value="bank">Bank Loan/Card</option>
                                    <option value="personal">Personal Savings</option>
                                    <option value="investor">External Investor</option>
                                </select>
                            </div>
                            <div className="grid w-full items-center gap-1.5">
                                <label className="text-sm font-medium">Credit Limit / Max Amount</label>
                                <Input type="number" placeholder="0.00" value={newLimit} onChange={e => setNewLimit(e.target.value)} />
                            </div>
                            <Button onClick={handleCreate}>Save</Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {loading ? (
                <div>Loading...</div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {funds.map((fund) => (
                        <Card key={fund.id}>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium">
                                    {fund.type === 'bank' ? 'Bank Credit' : 'Capital'}
                                </CardTitle>
                                {fund.type === 'bank' ? <Building2 className="h-4 w-4 text-muted-foreground" /> : <Wallet className="h-4 w-4 text-muted-foreground" />}
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">{fund.name}</div>
                                <p className="text-xs text-muted-foreground">
                                    Limit: ฿{Number(fund.creditLimit).toLocaleString()}
                                </p>
                                <div className="mt-4 flex justify-end">
                                    <Button variant="ghost" size="sm" onClick={() => handleDelete(fund.id)} className="text-destructive hover:text-destructive">
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
