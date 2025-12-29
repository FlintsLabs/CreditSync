import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from "../../../components/ui/dialog";
import BorrowerForm from "./BorrowerForm";

interface BorrowerEditModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    borrower: any;
    onSuccess: () => void;
}

export default function BorrowerEditModal({ open, onOpenChange, borrower, onSuccess }: BorrowerEditModalProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Edit Borrower Profile</DialogTitle>
                    <DialogDescription>
                        Update information for {borrower?.name}. Click save when you're done.
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
