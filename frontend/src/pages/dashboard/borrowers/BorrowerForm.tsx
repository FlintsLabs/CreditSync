import { useState, useEffect } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/card";
import { Upload, Loader2, CheckCircle, MapPin } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { TagInput } from "../../../components/ui/tag-input";

interface BorrowerFormProps {
    initialData?: any;
    onSuccess?: () => void;
}

export default function BorrowerForm({ initialData, onSuccess }: BorrowerFormProps) {
    const navigate = useNavigate();
    const [uploading, setUploading] = useState(false);
    const [idCardPreview, setIdCardPreview] = useState<string | null>(initialData?.idCardImageUrl || null);

    // Form State
    const [formData, setFormData] = useState({
        name: "",
        idCardNumber: "",
        phone: "",
        address: "",
        idCardImageUrl: "",
        googleMapsUrl: "",
        tags: [] as string[],
        notes: ""
    });

    useEffect(() => {
        if (initialData) {
            setFormData({
                name: initialData.name || "",
                idCardNumber: initialData.idCardNumber || "",
                phone: initialData.phone || "",
                address: initialData.address || "",
                idCardImageUrl: initialData.idCardImageUrl || "",
                googleMapsUrl: initialData.googleMapsUrl || "",
                tags: initialData.tags || [],
                notes: initialData.notes || ""
            });
            setIdCardPreview(initialData.idCardImageUrl);
        }
    }, [initialData]);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Preview
        const objectUrl = URL.createObjectURL(file);
        setIdCardPreview(objectUrl);

        // Upload
        setUploading(true);
        const formDataUpload = new FormData();
        formDataUpload.append("file", file);

        try {
            const res = await api.post("/files/upload", formDataUpload, {
                headers: { "Content-Type": "multipart/form-data" }
            });

            const uploadedUrl = res.data.url;
            setFormData(prev => ({ ...prev, idCardImageUrl: uploadedUrl }));

            // OCR
            console.log("Processing OCR...");
            const ocrRes = await api.post("/borrowers/extract-id-card", formDataUpload, {
                headers: { "Content-Type": "multipart/form-data" }
            });
            console.log("OCR Result:", ocrRes.data);

            const { idCardNumber, text } = ocrRes.data;

            setFormData(prev => ({
                ...prev,
                idCardNumber: idCardNumber || prev.idCardNumber,
                notes: prev.notes ? `${prev.notes}\nOCR Scanned:\n${text}` : `OCR Scanned:\n${text}`
            }));
        } finally {
            setUploading(false);
        }
    };

    const handleSubmit = async () => {
        try {
            // Clean payload
            const payload = {
                ...formData,
                idCardNumber: formData.idCardNumber || undefined,
                phone: formData.phone || undefined,
                address: formData.address || undefined,
                idCardImageUrl: formData.idCardImageUrl || undefined,
                googleMapsUrl: formData.googleMapsUrl || undefined,
                notes: formData.notes || undefined,
            };

            if (initialData) {
                await api.put(`/borrowers/${initialData.id}`, payload);
            } else {
                await api.post("/borrowers", payload);
            }

            if (onSuccess) {
                onSuccess();
            } else {
                navigate("/dashboard/borrowers");
            }
        } catch (error) {
            console.error(error);
            alert("Save failed");
        }
    };

    const formatThaiID = (value: string) => {
        const cleaned = value.replace(/\D/g, "");
        const truncated = cleaned.slice(0, 13);
        let formatted = truncated;
        if (truncated.length > 1) formatted = truncated.slice(0, 1) + '-' + truncated.slice(1);
        if (truncated.length > 5) formatted = formatted.slice(0, 6) + '-' + formatted.slice(6);
        if (truncated.length > 10) formatted = formatted.slice(0, 12) + '-' + formatted.slice(12);
        if (truncated.length > 12) formatted = formatted.slice(0, 15) + '-' + formatted.slice(15);
        return { formatted, raw: truncated };
    };

    const handleIdCardChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { formatted } = formatThaiID(e.target.value);
        setFormData({ ...formData, idCardNumber: formatted });
    };

    return (
        <div className="space-y-6">
            {!initialData && (
                <div className="h-16 flex items-center sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 -mx-6 px-6 border-b mb-6">
                    <h2 className="text-xl font-bold tracking-tight">New Borrower</h2>
                </div>
            )}

            <Card className="rounded-xl shadow-sm">
                <CardHeader>
                    <CardTitle>ID Card Identification</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-4">
                        <div className="relative h-40 w-64 rounded-xl border-2 border-dashed bg-muted flex items-center justify-center overflow-hidden">
                            {idCardPreview ? (
                                <img src={idCardPreview} alt="Preview" className="h-full w-full object-cover" />
                            ) : (
                                <div className="text-center text-muted-foreground">
                                    <Upload className="mx-auto h-8 w-8 mb-2" />
                                    <span>Upload ID Card</span>
                                </div>
                            )}
                            <input
                                type="file"
                                className="absolute inset-0 opacity-0 cursor-pointer"
                                accept="image/*"
                                onChange={handleFileChange}
                            />
                        </div>
                        <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">
                                Upload IT Card image to auto-fill information using OCR.
                            </p>
                            {uploading && <div className="flex items-center text-blue-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing ID Card...</div>}
                            {!uploading && formData.idCardImageUrl && <div className="flex items-center text-green-500"><CheckCircle className="mr-2 h-4 w-4" /> Uploaded & Scanned</div>}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card className="rounded-xl shadow-sm">
                <CardHeader>
                    <CardTitle>Personal Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <label>Full Name <span className="text-red-500">*</span></label>
                        <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="Required" />
                    </div>

                    <div className="grid gap-2">
                        <label>Tags <span className="text-muted-foreground text-xs">(Enter to add)</span></label>
                        <TagInput tags={formData.tags} onTagsChange={(tags) => setFormData({ ...formData, tags })} placeholder="e.g. facebook, referral, vip" />
                    </div>

                    <div className="grid gap-2">
                        <label>ID Card Number <span className="text-muted-foreground text-xs">(Optional, 13 digits)</span></label>
                        <Input
                            value={formData.idCardNumber}
                            onChange={handleIdCardChange}
                            placeholder="x-xxxx-xxxxx-xx-x"
                            maxLength={17}
                        />
                    </div>
                    <div className="grid gap-2">
                        <label>Phone Number <span className="text-muted-foreground text-xs">(Optional)</span></label>
                        <Input value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>Google Maps URL <span className="text-muted-foreground text-xs">(Optional)</span></label>
                        <div className="relative">
                            <MapPin className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                className="pl-9"
                                value={formData.googleMapsUrl}
                                onChange={e => setFormData({ ...formData, googleMapsUrl: e.target.value })}
                                placeholder="https://maps.google.com/..."
                            />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <label>Address <span className="text-muted-foreground text-xs">(Optional)</span></label>
                        <Input value={formData.address} onChange={e => setFormData({ ...formData, address: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>Notes</label>
                        <Input value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} />
                    </div>

                    <Button className="w-full" onClick={handleSubmit} disabled={!formData.name}>
                        {initialData ? "Save Changes" : "Create Borrower Profile"}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
