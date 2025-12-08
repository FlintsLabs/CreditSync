import { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Plus, Users, Search } from "lucide-react";
import { Input } from "../../../components/ui/Input";
import { Link } from "react-router-dom";

export default function BorrowerList() {
    const [borrowers, setBorrowers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchBorrowers();
    }, []);

    const fetchBorrowers = async () => {
        try {
            const res = await axios.get("http://localhost:3000/borrowers");
            setBorrowers(res.data);
        } catch (error) {
            console.error("Failed", error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Borrowers</h2>
                    <p className="text-muted-foreground">Manage your customer profiles and documents.</p>
                </div>
                <Link to="/dashboard/borrowers/new">
                    <Button>
                        <Plus className="mr-2 h-4 w-4" /> New Borrower
                    </Button>
                </Link>
            </div>

            {/* Search - Placeholder */}
            <div className="flex w-full max-w-sm items-center space-x-2">
                <Input placeholder="Search name or ID card..." />
                <Button type="submit" size="icon" variant="ghost">
                    <Search className="h-4 w-4" />
                </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {borrowers.map((b) => (
                    <Card key={b.id}>
                        <CardHeader className="flex flex-row items-center gap-4">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                                {b.photoUrl ? (
                                    <img src={b.photoUrl} alt="Avatar" className="h-full w-full rounded-full object-cover" />
                                ) : (
                                    <Users className="h-6 w-6 text-muted-foreground" />
                                )}
                            </div>
                            <div>
                                <CardTitle className="text-lg">{b.name}</CardTitle>
                                <div className="text-sm text-muted-foreground">{b.idCardNumber || "No ID Card"}</div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="text-sm">
                                <p><strong>Phone:</strong> {b.phone || "-"}</p>
                                <p><strong>Address:</strong> {b.address || "-"}</p>
                                <p><strong>Credit Score:</strong> {b.creditScore}</p>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
