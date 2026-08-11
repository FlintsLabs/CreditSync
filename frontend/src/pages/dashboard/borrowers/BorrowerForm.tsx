import { useState, useEffect } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Upload, Loader2, CheckCircle, MapPin } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { TagInput } from "../../../components/ui/tag-input";
import { useTranslation } from "react-i18next";
import { EvidencePreviewButton } from "../../../components/evidence/EvidencePreviewButton";

interface BorrowerFormProps {
    initialData?: any;
    onSuccess?: () => void;
}

export default function BorrowerForm({ initialData, onSuccess }: BorrowerFormProps) {
    const { t } = useTranslation();
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
                idCardImageUrl: initialData.idCardImageRef || initialData.idCardImageUrl || "",
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

            setIdCardPreview(res.data.url);
            setFormData(prev => ({ ...prev, idCardImageUrl: res.data.fileRef || res.data.url }));

            // OCR
            const ocrRes = await api.post("/borrowers/extract-id-card", formDataUpload, {
                headers: { "Content-Type": "multipart/form-data" }
            });

            const { idCardNumber, text } = ocrRes.data;

            setFormData(prev => ({
                ...prev,
                idCardNumber: idCardNumber || prev.idCardNumber,
                notes: prev.notes ? `${prev.notes}\n${t("borrowerForm.ocrScanned", "OCR Scanned")}:\n${text}` : `${t("borrowerForm.ocrScanned", "OCR Scanned")}:\n${text}`
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
                navigate("/borrowers");
            }
        } catch (error) {
            console.error(error);
            alert(t("borrowerForm.saveFailed", "Save failed"));
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
                    <h2 className="text-xl font-bold tracking-tight">{t("borrowers.new", "New Borrower")}</h2>
                </div>
            )}

            <Card className="rounded-xl shadow-sm">
                <CardHeader>
                    <CardTitle>{t("borrowerForm.idCardIdentification", "ID Card Identification")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-4">
                        <div className="relative h-40 w-64 rounded-xl border-2 border-dashed bg-muted flex items-center justify-center overflow-hidden">
                            {idCardPreview ? (
                                <img src={idCardPreview} alt={t("borrowerForm.preview", "Preview")} className="h-full w-full object-cover" />
                            ) : (
                                <div className="text-center text-muted-foreground">
                                    <Upload className="mx-auto h-8 w-8 mb-2" />
                                    <span>{t("borrowerForm.uploadIdCard", "Upload ID Card")}</span>
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
                                {t("borrowerForm.uploadDescription", "Upload ID Card image to auto-fill information using OCR.")}
                            </p>
                            {uploading && <div className="flex items-center text-blue-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("borrowerForm.analyzing", "Analyzing ID Card...")}</div>}
                            {!uploading && formData.idCardImageUrl && <div className="flex items-center text-green-500"><CheckCircle className="mr-2 h-4 w-4" /> {t("borrowerForm.uploadedScanned", "Uploaded & Scanned")}</div>}
                            {idCardPreview && <EvidencePreviewButton available label={t("evidence.previewIdCard")} mimeType="image/*" resolve={async () => ({ url: idCardPreview, mimeType: "image/*" })} />}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card className="rounded-xl shadow-sm">
                <CardHeader>
                    <CardTitle>{t("borrowerForm.personalInformation", "Personal Information")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <label>{t("borrowerForm.fullName", "Full Name")} <span className="text-red-500">*</span></label>
                        <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder={t("borrowerForm.required", "Required")} />
                    </div>

                    <div className="grid gap-2">
                        <label>{t("borrowerForm.tags", "Tags")} <span className="text-muted-foreground text-xs">({t("borrowerForm.enterToAdd", "Enter to add")})</span></label>
                        <TagInput tags={formData.tags} onTagsChange={(tags) => setFormData({ ...formData, tags })} placeholder={t("borrowerForm.tagsPlaceholder", "e.g. facebook, referral, vip")} />
                    </div>

                    <div className="grid gap-2">
                        <label>{t("borrowerDetail.idCard", "ID Card")} <span className="text-muted-foreground text-xs">({t("borrowerForm.optional13Digits", "Optional, 13 digits")})</span></label>
                        <Input
                            value={formData.idCardNumber}
                            onChange={handleIdCardChange}
                            placeholder="x-xxxx-xxxxx-xx-x"
                            maxLength={17}
                        />
                    </div>
                    <div className="grid gap-2">
                        <label>{t("borrowerForm.phoneNumber", "Phone Number")} <span className="text-muted-foreground text-xs">({t("borrowerForm.optional", "Optional")})</span></label>
                        <Input value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>{t("borrowerForm.googleMapsUrl", "Google Maps URL")} <span className="text-muted-foreground text-xs">({t("borrowerForm.optional", "Optional")})</span></label>
                        <div className="relative">
                            <MapPin className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                className="pl-9"
                                value={formData.googleMapsUrl}
                                onChange={e => setFormData({ ...formData, googleMapsUrl: e.target.value })}
                                placeholder={t("borrowerForm.mapsPlaceholder", "https://maps.google.com/...")}
                            />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <label>{t("borrowerDetail.address", "Address")} <span className="text-muted-foreground text-xs">({t("borrowerForm.optional", "Optional")})</span></label>
                        <Input value={formData.address} onChange={e => setFormData({ ...formData, address: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>{t("transactionsForm.notes", "Notes")}</label>
                        <Input value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} />
                    </div>

                    <Button className="w-full" onClick={handleSubmit} disabled={!formData.name}>
                        {initialData ? t("borrowerForm.saveChanges", "Save Changes") : t("borrowerForm.createProfile", "Create Borrower Profile")}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
