import { BlobSASPermissions, BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type StorageProvider = "s3" | "azure-blob";

export interface StoredObjectLocation {
    provider: StorageProvider;
    bucket: string;
    key: string;
}

const storageProvider: StorageProvider = process.env.STORAGE_PROVIDER === "azure-blob" ? "azure-blob" : "s3";
const signedUrlTtlSeconds = Math.max(60, Math.min(900, Number(process.env.FILE_URL_TTL_SECONDS ?? 900)));

const s3AccessKeyId = process.env.MINIO_ROOT_USER || process.env.MINIO_ACCESS_KEY || "minioadmin";
const s3SecretAccessKey = process.env.MINIO_ROOT_PASSWORD || process.env.MINIO_SECRET_KEY || "minioadmin";
const s3Endpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || "http://localhost:9000";
const s3PublicEndpoint = process.env.S3_PUBLIC_URL || process.env.MINIO_PUBLIC_URL || s3Endpoint;

const azureAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const azureAccountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const azureEndpoint = process.env.AZURE_STORAGE_ENDPOINT || (azureAccountName ? `https://${azureAccountName}.blob.core.windows.net` : undefined);

export const BUCKET_NAME = process.env.S3_BUCKET || process.env.AZURE_STORAGE_CONTAINER || "creditsync-files";

export interface SignedPutRequest {
    bucket?: string;
    key: string;
    contentType: string;
    contentLength: number;
    checksumSha256: string;
    metadata: Record<string, string>;
}

export interface StoredObjectHead {
    exists: boolean;
    contentType: string | null;
    contentLength: number | null;
    checksumSha256: string | null;
    metadata: Record<string, string>;
}

export type SignedPutResult = { uploadUrl: string; expiresAt: Date; requiredHeaders: Record<string, string> };

const s3 = new S3Client({
    region: "us-east-1",
    endpoint: s3Endpoint,
    credentials: {
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
    },
    forcePathStyle: true,
});

const s3Signer = new S3Client({
    region: "us-east-1",
    endpoint: s3PublicEndpoint,
    credentials: {
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
    },
    forcePathStyle: true,
});

const azureCredential = azureAccountName && azureAccountKey
    ? new StorageSharedKeyCredential(azureAccountName, azureAccountKey)
    : null;

const azureServiceClient = azureEndpoint && azureCredential
    ? new BlobServiceClient(azureEndpoint, azureCredential)
    : null;

function getAzureServiceClient() {
    if (!azureServiceClient || !azureCredential) {
        throw new Error("Azure Blob storage requires AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY, and AZURE_STORAGE_ENDPOINT");
    }

    return { serviceClient: azureServiceClient, credential: azureCredential };
}

export function toStorageReference(location: StoredObjectLocation) {
    return `storage://${location.provider}/${encodeURIComponent(location.bucket)}/${encodeURIComponent(location.key)}`;
}

export function parseStorageReference(value: string): StoredObjectLocation | null {
    const match = value.match(/^storage:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) {
        return null;
    }

    const provider = match[1] as StorageProvider;
    if (provider !== "s3" && provider !== "azure-blob") {
        return null;
    }

    return {
        provider,
        bucket: decodeURIComponent(match[2]),
        key: decodeURIComponent(match[3]),
    };
}

async function ensureS3Bucket(bucket: string) {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        console.log(`Bucket ${bucket} created`);
    }
}

function hexChecksumToBase64(value: string) {
    return Buffer.from(value, "hex").toString("base64");
}

function base64ChecksumToHex(value: string | undefined) {
    return value ? Buffer.from(value, "base64").toString("hex") : null;
}

export function signedPutRequiredHeaders(request: SignedPutRequest): Record<string, string> {
    return {
        "content-type": request.contentType,
        "x-amz-checksum-sha256": hexChecksumToBase64(request.checksumSha256),
        ...Object.fromEntries(Object.entries(request.metadata).map(([key, value]) => [`x-amz-meta-${key.toLocaleLowerCase()}`, value])),
    };
}

export function signedPutSigningOptions(request: SignedPutRequest, expiresIn: number) {
    const requiredHeaders = signedPutRequiredHeaders(request);
    return {
        expiresIn,
        signableHeaders: new Set(["content-type"]),
        unhoistableHeaders: new Set(Object.keys(requiredHeaders).filter((header) => header.startsWith("x-amz-"))),
    };
}

export async function createSignedPutUrl(request: SignedPutRequest) {
    if (storageProvider !== "s3") {
        throw new Error("Payment evidence upload intents require S3-compatible storage");
    }
    const bucket = request.bucket ?? BUCKET_NAME;
    await ensureS3Bucket(bucket);
    const expiresIn = Math.max(60, Math.min(900, Number(process.env.EVIDENCE_UPLOAD_TTL_SECONDS ?? 300)));
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: request.key,
        ContentType: request.contentType,
        ContentLength: request.contentLength,
        ChecksumSHA256: hexChecksumToBase64(request.checksumSha256),
        Metadata: request.metadata,
    });
    const requiredHeaders = signedPutRequiredHeaders(request);
    return {
        uploadUrl: await getSignedUrl(s3Signer as any, command as any, signedPutSigningOptions(request, expiresIn)),
        expiresAt: new Date(Date.now() + expiresIn * 1000),
        requiredHeaders,
    };
}

export async function headStoredObject(key: string, bucket = BUCKET_NAME): Promise<StoredObjectHead> {
    if (storageProvider !== "s3") {
        throw new Error("Payment evidence finalization requires S3-compatible storage");
    }
    try {
        const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
        return {
            exists: true,
            contentType: response.ContentType ?? null,
            contentLength: response.ContentLength ?? null,
            checksumSha256: base64ChecksumToHex(response.ChecksumSHA256),
            metadata: response.Metadata ?? {},
        };
    } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
            return { exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} };
        }
        throw error;
    }
}

async function ensureAzureContainer(bucket: string) {
    const { serviceClient } = getAzureServiceClient();
    await serviceClient.getContainerClient(bucket).createIfNotExists();
}

export async function uploadFile(key: string, body: Buffer | Uint8Array, contentType: string, bucket = BUCKET_NAME): Promise<StoredObjectLocation> {
    if (storageProvider === "azure-blob") {
        await ensureAzureContainer(bucket);
        const { serviceClient } = getAzureServiceClient();
        await serviceClient.getContainerClient(bucket).getBlockBlobClient(key).uploadData(body, {
            blobHTTPHeaders: {
                blobContentType: contentType,
            },
        });

        return {
            provider: "azure-blob",
            bucket,
            key,
        };
    }

    await ensureS3Bucket(bucket);
    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
    }));

    return {
        provider: "s3",
        bucket,
        key,
    };
}

export async function createSignedObjectUrl(location: StoredObjectLocation): Promise<string> {
    if (location.provider === "azure-blob") {
        const { serviceClient, credential } = getAzureServiceClient();
        const blobClient = serviceClient.getContainerClient(location.bucket).getBlobClient(location.key);
        const startsOn = new Date(Date.now() - 5 * 60 * 1000);
        const expiresOn = new Date(Date.now() + signedUrlTtlSeconds * 1000);
        const sasToken = generateBlobSASQueryParameters({
            containerName: location.bucket,
            blobName: location.key,
            permissions: BlobSASPermissions.parse("r"),
            startsOn,
            expiresOn,
        }, credential).toString();

        return `${blobClient.url}?${sasToken}`;
    }

    return await getSignedUrl(s3Signer as any, new GetObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
    }) as any, {
        expiresIn: signedUrlTtlSeconds,
    });
}

export async function createSignedObjectAccess(location: StoredObjectLocation) {
    return {
        url: await createSignedObjectUrl(location),
        expiresAt: new Date(Date.now() + signedUrlTtlSeconds * 1000),
    };
}

export async function resolveStoredFileUrl(value: string | null | undefined): Promise<string | null> {
    if (!value) {
        return null;
    }

    const parsed = parseStorageReference(value);
    if (!parsed) {
        return value;
    }

    return await createSignedObjectUrl(parsed);
}

export async function downloadFile(key: string, bucket = BUCKET_NAME): Promise<Buffer> {
    if (storageProvider === "azure-blob") {
        const { serviceClient } = getAzureServiceClient();
        return Buffer.from(await serviceClient.getContainerClient(bucket).getBlobClient(key).downloadToBuffer());
    }

    const response = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
    if (!response.Body) {
        throw new Error("Empty response body");
    }

    return Buffer.from(await response.Body.transformToByteArray());
}
