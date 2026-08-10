import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Check, Copy, Edit2, Eye, MapPin } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "../../../components/ui/avatar";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../../components/ui/Card";
import { formatThaiNationalId, maskThaiNationalId } from "../../../lib/thai-national-id";

export type BorrowerCardBorrower = {
  id: string | number;
  publicId?: string | null;
  name?: string | null;
  photoUrl?: string | null;
  idCardNumber?: string | null;
  tags?: string[] | null;
  phone?: string | null;
  creditScore?: number | null;
  googleMapsUrl?: string | null;
};

type BorrowerCardProps = {
  borrower: BorrowerCardBorrower;
  onEdit: (borrower: BorrowerCardBorrower) => void;
};

type CopyStatus = "success" | "error" | null;

function getInitials(name?: string | null) {
  if (!name) return "U";

  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function BorrowerCard({ borrower, onEdit }: BorrowerCardProps) {
  const { t } = useTranslation();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>(null);
  const statusTimeout = useRef<number | undefined>(undefined);
  const formattedId = formatThaiNationalId(borrower.idCardNumber);
  const maskedId = maskThaiNationalId(borrower.idCardNumber);
  const rawId = formattedId && typeof borrower.idCardNumber === "string"
    ? borrower.idCardNumber.replace(/\D/g, "")
    : null;

  useEffect(() => () => {
    if (statusTimeout.current !== undefined) {
      window.clearTimeout(statusTimeout.current);
    }
  }, []);

  const setTemporaryCopyStatus = (status: Exclude<CopyStatus, null>) => {
    if (statusTimeout.current !== undefined) {
      window.clearTimeout(statusTimeout.current);
    }
    setCopyStatus(status);
    statusTimeout.current = window.setTimeout(() => setCopyStatus(null), 3000);
  };

  const copyIdCard = async () => {
    if (!rawId) return;

    try {
      await navigator.clipboard.writeText(rawId);
      setTemporaryCopyStatus("success");
    } catch {
      setTemporaryCopyStatus("error");
    }
  };

  const borrowerName = borrower.name || t("common.unknown", "Unknown");

  return (
    <Card className="w-full rounded-xl border-l-4 border-l-primary/50 transition-all hover:shadow-md">
      <CardHeader className="flex min-w-0 flex-row items-start gap-3 pb-2">
        <Avatar className="h-12 w-12 shrink-0 border-2 border-white shadow-sm">
          <AvatarImage src={borrower.photoUrl ?? undefined} />
          <AvatarFallback className="bg-primary/10 font-bold text-primary">
            {getInitials(borrower.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <CardTitle className="min-w-0 break-words text-lg leading-snug">{borrowerName}</CardTitle>
          <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {maskedId ? (
              <>
                <span className="font-mono tabular-nums">{maskedId}</span>
                <Button
                  aria-label={t("borrowers.copyIdCard", "Copy ID card for {{name}}", { name: borrowerName })}
                  className="h-6 w-6 shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  onClick={copyIdCard}
                  size="icon"
                  title={t("borrowers.copyIdCard", "Copy ID card for {{name}}", { name: borrowerName })}
                  type="button"
                  variant="ghost"
                >
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <span>{t("borrowers.noIdCard", "No ID Card")}</span>
            )}
          </div>
          {copyStatus && (
            <p aria-live="polite" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground" role="status">
              {copyStatus === "success" && <Check aria-hidden="true" className="h-3 w-3 text-green-600" />}
              {copyStatus === "success"
                ? t("borrowers.idCardCopied", "ID card copied.")
                : t("borrowers.idCardCopyFailed", "Unable to copy ID card.")}
            </p>
          )}
          {borrower.tags && borrower.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {borrower.tags.slice(0, 3).map((tag) => (
                <Badge className="h-4 px-1 py-0 text-[10px]" key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
              {borrower.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">+{borrower.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="pb-2">
        <div className="space-y-1 text-sm">
          <p className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("borrowers.phone", "Phone")}:</span>
            <span className="break-all text-right">{borrower.phone || "-"}</span>
          </p>
          <p className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("borrowers.creditScore", "Credit Score")}:</span>
            <span className={borrower.creditScore && borrower.creditScore > 700 ? "font-bold text-green-600" : "text-amber-600"}>
              {borrower.creditScore ?? "-"}
            </span>
          </p>
          {borrower.googleMapsUrl && (
            <a className="mt-1 flex items-center text-xs text-blue-500 hover:underline" href={borrower.googleMapsUrl} rel="noreferrer" target="_blank">
              <MapPin className="mr-1 h-3 w-3" /> {t("borrowers.viewMap", "View Map Location")}
            </a>
          )}
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t bg-muted/20 pt-2">
        <Button className="h-8 rounded-full" onClick={() => onEdit(borrower)} size="sm" variant="ghost">
          <Edit2 className="mr-1 h-3 w-3" /> {t("common.edit", "Edit")}
        </Button>
        <Link to={`/borrowers/${borrower.publicId ?? borrower.id}`}>
          <Button className="h-8 rounded-full" size="sm" variant="outline">
            <Eye className="mr-1 h-3 w-3" /> {t("common.details", "Details")}
          </Button>
        </Link>
      </CardFooter>
    </Card>
  );
}
