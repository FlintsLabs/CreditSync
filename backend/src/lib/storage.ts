import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

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

export async function ensureBucket() {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    } catch (error) {
        try {
            await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
            console.log(`Bucket ${BUCKET_NAME} created`);
        } catch (createError) {
            console.error("Failed to create bucket", createError);
            throw createError;
        }
    }
}

export async function uploadFile(key: string, body: Buffer | Uint8Array, contentType: string) {
    await ensureBucket();
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

export async function downloadFile(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });

    try {
        const response = await s3.send(command);
        if (!response.Body) {
            throw new Error("Empty response body");
        }
        // Convert stream to buffer
        const byteArray = await response.Body.transformToByteArray();
        return Buffer.from(byteArray);
    } catch (error) {
        console.error("S3 Download Error", error);
        throw error;
    }
}
