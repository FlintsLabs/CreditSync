import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
    region: "us-east-1", // MinIO default
    endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
    credentials: {
        accessKeyId: process.env.MINIO_ROOT_USER || "minioadmin",
        secretAccessKey: process.env.MINIO_ROOT_PASSWORD || "minioadmin",
    },
    forcePathStyle: true, // Required for MinIO
});

export const BUCKET_NAME = process.env.S3_BUCKET || "creditsync-files";

export async function uploadFile(key: string, body: Buffer | Uint8Array, contentType: string) {
    // Create bucket if not exists (Lazy init - simpler for dev)
    try {
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType
        }));
        return `${process.env.S3_PUBLIC_URL || "http://localhost:9000"}/${BUCKET_NAME}/${key}`;
    } catch (error) {
        console.error("S3 Upload Error", error);
        throw error;
    }
}
