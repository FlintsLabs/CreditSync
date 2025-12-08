import { useState } from "react";
import axios from "axios";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Upload, Loader2, CheckCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function BorrowerForm() {
    const navigate = useNavigate();
    const [uploading, setUploading] = useState(false);
    const [idCardPreview, setIdCardPreview] = useState<string | null>(null);

    // Form State
    const [formData, setFormData] = useState({
        name: "",
        idCardNumber: "",
        phone: "",
        address: "",
        idCardImageUrl: "" // To store S3 URL
    });

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
            const res = await axios.post("http://localhost:3000/files/upload", formDataUpload, {
                headers: { "Content-Type": "multipart/form-data" }
            });

            const uploadedUrl = res.data.url;
            setFormData(prev => ({ ...prev, idCardImageUrl: uploadedUrl }));

            // SIMULATE OCR (Here we would call OCR API)
            console.log("Simulating OCR...");
            setTimeout(() => {
                // Mock auto-fill based on file name or random
                if (!formData.name) {
                    setFormData(prev => ({
                        ...prev,
                        name: "Simulated Name (OCR)",
                        idCardNumber: "1-2345-67890-12-3",
                        address: "123 Mock Address, Bangkok"
                    }));
                }
            }, 1000);

        } catch (error) {
            console.error("Upload failed", error);
            alert("Upload failed");
        } finally {
            setUploading(false);
        }
    };

    const handleSubmit = async () => {
        try {
            await axios.post("http://localhost:3000/borrowers", formData);
            navigate("/dashboard/borrowers");
        } catch (error) {
            alert("Create failed");
        }
    };

    return (
        <div className="max-w-2xl mx-auto space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">New Borrower</h2>

            <Card>
                <CardHeader>
                    <CardTitle>ID Card Identifiction</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-4">
                        <div className="relative h-40 w-64 rounded-md border-2 border-dashed bg-muted flex items-center justify-center overflow-hidden">
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

            <Card>
                <CardHeader>
                    <CardTitle>Personal Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <label>Full Name</label>
                        <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
                    </div>
                    <div className="grid gap-2">
                        <label>ID Card Number</label>
                        <Input value={formData.idCardNumber} onChange={e => setFormData({ ...formData, idCardNumber: e.target.value })} />
                    </div>
                    <div className="grid gap-2">
                        <label>Phone Number</label>
                        <Input value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} />
                    </div>
                    <div className="grid gap-2">
                        <label>Address</label>
                        <Input value={formData.address} onChange={e => setFormData({ ...formData, address: e.target.value })} />
                    </div>

                    <Button className="w-full" onClick={handleSubmit} disabled={!formData.name}>
                        Create Borrower Profile
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
