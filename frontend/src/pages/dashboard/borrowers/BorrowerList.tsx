import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Plus, Search, Users } from "lucide-react";
import { Input } from "../../../components/ui/Input";
import { Link } from "react-router-dom";
import BorrowerEditModal from "./BorrowerEditModal";
import BorrowerCard from "./BorrowerCard";
import { useTranslation } from "react-i18next";

export default function BorrowerList() {
    const { t } = useTranslation();
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

    return (
        <div className="space-y-6">
            <div className="h-16 flex items-center justify-between sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 -mx-6 px-6 border-b">
                <h2 className="text-xl font-bold tracking-tight">{t("borrowers.title", "Borrowers")}</h2>
                <Link to="/borrowers/new">
                    <Button className="rounded-full shadow-lg" size="sm">
                        <Plus className="mr-2 h-4 w-4" /> {t("borrowers.new", "New Borrower")}
                    </Button>
                </Link>
            </div>

            {/* Search - Placeholder */}
            <div className="flex w-full max-w-sm items-center space-x-2">
                <Input placeholder={t("borrowers.search", "Search name or ID card...")} className="rounded-full" />
                <Button type="submit" size="icon" variant="ghost" className="rounded-full">
                    <Search className="h-4 w-4" />
                </Button>
            </div>

            {borrowers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <Users className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">{t("borrowers.emptyTitle", "No Borrowers Found")}</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        {t("borrowers.emptyDescription", "Get started by creating your first borrower profile to track loans and credit scores.")}
                    </p>
                    <Link to="/borrowers/new">
                        <Button className="mt-6 rounded-full shadow-lg">
                            <Plus className="mr-2 h-4 w-4" /> {t("borrowers.create", "Create Borrower")}
                        </Button>
                    </Link>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="borrower-card-grid">
                    {borrowers.map((borrower) => (
                        <BorrowerCard borrower={borrower} key={borrower.id} onEdit={handleEdit} />
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
