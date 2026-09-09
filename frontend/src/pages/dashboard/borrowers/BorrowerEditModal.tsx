import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from "../../../components/ui/dialog";
import BorrowerForm from "./BorrowerForm";
import { useTranslation } from "react-i18next";

interface BorrowerEditModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    borrower: any;
    onSuccess: () => void;
}

export default function BorrowerEditModal({ open, onOpenChange, borrower, onSuccess }: BorrowerEditModalProps) {
    const { t } = useTranslation();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t("borrowerEdit.title", "Edit Borrower Profile")}</DialogTitle>
                    <DialogDescription>
                        {t("borrowerEdit.description", { defaultValue: "Update information for {{name}}. Click save when you're done.", name: borrower?.name ?? "" })}
                    </DialogDescription>
                </DialogHeader>

                {borrower && (
                    <BorrowerForm
                        initialData={borrower}
                        onSuccess={() => {
                            onSuccess();
                            onOpenChange(false);
                        }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
