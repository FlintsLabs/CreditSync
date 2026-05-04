import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../../../components/ui/Card";
import { Plus, Search, Edit2, Eye, MapPin, Users } from "lucide-react";
import { Input } from "../../../components/ui/Input";
import { Link } from "react-router-dom";
import { Avatar, AvatarImage, AvatarFallback } from "../../../components/ui/avatar";
import { Badge } from "../../../components/ui/badge";
import BorrowerEditModal from "./BorrowerEditModal";

export default function BorrowerList() {
    const [borrowers, setBorrowers] = useState<any[]>([]);

    // Edit Modal State
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [selectedBorrower, setSelectedBorrower] = useState<any>(null);

    useEffect(() => {
        fetchBorrowers();
    }, []);

    const fetchBorrowers = async () => {
        try {
            const res = await api.get("/borrowers");
            setBorrowers(res.data);
        } catch (error) {
            console.error("Failed", error);
        }
    };

    const handleEdit = (borrower: any) => {
        setSelectedBorrower(borrower);
        setEditModalOpen(true);
    };

    const getInitials = (name: string) => {
        if (!name) return "U";
        return name
            .split(" ")
            .map((n) => n[0])
            .slice(0, 2)
            .join("")
            .toUpperCase();
    };

    return (
        <div className="space-y-6">
            <div className="h-16 flex items-center justify-between sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 -mx-6 px-6 border-b">
                <h2 className="text-xl font-bold tracking-tight">Borrowers</h2>
                <Link to="/dashboard/borrowers/new">
                    <Button className="rounded-full shadow-lg" size="sm">
                        <Plus className="mr-2 h-4 w-4" /> New Borrower
                    </Button>
                </Link>
            </div>

            {/* Search - Placeholder */}
            <div className="flex w-full max-w-sm items-center space-x-2">
                <Input placeholder="Search name or ID card..." className="rounded-full" />
                <Button type="submit" size="icon" variant="ghost" className="rounded-full">
                    <Search className="h-4 w-4" />
                </Button>
            </div>

            {borrowers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <Users className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">No Borrowers Found</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        Get started by creating your first borrower profile to track loans and credit scores.
                    </p>
                    <Link to="/dashboard/borrowers/new">
                        <Button className="mt-6 rounded-full shadow-lg">
                            <Plus className="mr-2 h-4 w-4" /> Create Borrower
                        </Button>
                    </Link>
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {borrowers.map((b) => (
                        <Card key={b.id} className="rounded-xl hover:shadow-md transition-all border-l-4 border-l-primary/50">
                            <CardHeader className="flex flex-row items-center gap-4 pb-2">
                                <Avatar className="h-14 w-14 border-2 border-white shadow-sm">
                                    <AvatarImage src={b.photoUrl} />
                                    <AvatarFallback className="bg-primary/10 text-primary font-bold">
                                        {getInitials(b.name)}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="overflow-hidden">
                                    <CardTitle className="text-lg truncate">{b.name}</CardTitle>
                                    <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                                        {b.idCardNumber || "No ID Card"}
                                    </div>
                                    {b.tags && b.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1">
                                            {b.tags.slice(0, 3).map((tag: string) => (
                                                <Badge key={tag} variant="secondary" className="text-[10px] px-1 py-0 h-4">
                                                    {tag}
                                                </Badge>
                                            ))}
                                            {b.tags.length > 3 && (
                                                <span className="text-[10px] text-muted-foreground">+{b.tags.length - 3}</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </CardHeader>
                            <CardContent className="pb-2">
                                <div className="text-sm space-y-1">
                                    <p className="flex justify-between">
                                        <span className="text-muted-foreground">Phone:</span>
                                        <span>{b.phone || "-"}</span>
                                    </p>
                                    <p className="flex justify-between">
                                        <span className="text-muted-foreground">Credit Score:</span>
                                        <span className={b.creditScore > 700 ? "text-green-600 font-bold" : "text-amber-600"}>{b.creditScore}</span>
                                    </p>
                                    {b.googleMapsUrl && (
                                        <a href={b.googleMapsUrl} target="_blank" rel="noreferrer" className="flex items-center text-xs text-blue-500 hover:underline mt-1">
                                            <MapPin className="h-3 w-3 mr-1" /> View Map Location
                                        </a>
                                    )}
                                </div>
                            </CardContent>
                            <CardFooter className="flex justify-end gap-2 pt-2 border-t bg-muted/20 rounded-b-xl">
                                <Button variant="ghost" size="sm" onClick={() => handleEdit(b)} className="h-8 rounded-full">
                                    <Edit2 className="h-3 w-3 mr-1" /> Edit
                                </Button>
                                <Link to={`/dashboard/borrowers/${b.id}`}>
                                    <Button size="sm" variant="outline" className="h-8 rounded-full">
                                        <Eye className="h-3 w-3 mr-1" /> Details
                                    </Button>
                                </Link>
                            </CardFooter>
                        </Card>
                    ))}
                </div>
            )}

            <BorrowerEditModal
                open={editModalOpen}
                onOpenChange={setEditModalOpen}
                borrower={selectedBorrower}
                onSuccess={() => {
                    fetchBorrowers(); // Refresh list
                    setEditModalOpen(false);
                }}
            />
        </div>
    );
}
